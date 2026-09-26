import { Router, Response } from 'express';
import { randomBytes } from 'crypto';
import archiver from 'archiver';
import { pipeline, finished } from 'stream/promises';
import { DatabaseService } from '../models/database';
import { AuthRequest, createAuthMiddleware } from '../middleware/auth';
import { DownloadService, downloadCredentials, downloadFailure, DownloadError } from '../services/downloadService';
import { assertDownloadPolicy } from '../services/downloadPolicy';
import { logger } from '../utils/logger';

export function createDownloadsRouter(db: DatabaseService, service = new DownloadService()) {
  const router = Router();
  const auth = createAuthMiddleware(db);
  // Single-use, 60-second tickets allow a native browser POST straight to disk.
  // Neither Plex tokens nor app session tokens are exposed in download URLs.
  const tickets = new Map<string, { jobId: string; owner: string; session: string; expires: number }>();
  const credentials = (req: AuthRequest) => ({
    ...downloadCredentials(key => db.getSetting(key), req.user!),
    authorize: (quality: any, metadata: any, container: any) => assertDownloadPolicy(db, req.user!, quality, metadata, container),
  });
  const failure = (res: Response, error: unknown) => {
    const safe = downloadFailure(error);
    if (!res.headersSent) res.status(safe.status).json({ error: safe.message });
    else res.destroy();
  };
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  router.post('/', auth, async (req: AuthRequest, res) => {
    try { res.status(202).json(await service.create(req.user!.id, credentials(req), req.body)); }
    catch (error) { failure(res, error); }
  });
  router.get('/:id', auth, async (req: AuthRequest, res) => {
    try { res.json(await service.status(req.params.id, req.user!.id, credentials(req))); }
    catch (error) { failure(res, error); }
  });
  router.delete('/:id', auth, async (req: AuthRequest, res) => {
    try {
      await service.cancel(req.params.id, req.user!.id);
      for (const [key, value] of tickets) if (value.jobId === req.params.id) tickets.delete(key);
      res.status(204).end();
    } catch (error) { failure(res, error); }
  });
  router.post('/:id/ticket', auth, async (req: AuthRequest, res) => {
    try {
      const job = await service.status(req.params.id, req.user!.id, credentials(req));
      if (job.state !== 'ready') throw new DownloadError(409, job.error || 'Download is not ready.');
      for (const [key, value] of tickets) {
        if (value.expires <= Date.now() || value.jobId === job.id) tickets.delete(key);
      }
      const ticket = randomBytes(32).toString('hex');
      tickets.set(ticket, { jobId: job.id, owner: req.user!.id, session: req.authSession!.token, expires: Date.now() + 60000 });
      res.json({ ticket });
    } catch (error) { failure(res, error); }
  });
  router.post('/:id/file', (req: AuthRequest, res, next) => {
    const ticket = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
    const grant = tickets.get(ticket);
    tickets.delete(ticket);
    if (!grant || grant.expires <= Date.now() || grant.jobId !== req.params.id) {
      res.status(403).json({ error: 'Download link expired. Return to LibraryDownloadarr and click Save file again.' });
      return;
    }
    // Re-run normal authentication so logout/session expiry invalidates tickets.
    req.headers.authorization = `Bearer ${grant.session}`;
    auth(req, res, () => {
      if (req.user?.id !== grant.owner) { res.status(403).end(); return; }
      next();
    });
  }, async (req: AuthRequest, res) => {
    let started = false;
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned || !started) return;
      cleaned = true;
      try { await service.cancel(req.params.id, req.user!.id); } catch { /* Already removed/expired. */ }
    };
    res.once('close', () => { void cleanup(); });
    try {
      const transfer = await service.beginTransfer(req.params.id, req.user!.id, credentials(req));
      started = true;
      if (res.destroyed) { await cleanup(); return; }
      // Open before attachment headers: an upstream refusal must not look like a file.
      const first = await transfer.open(transfer.files[0]);
      res.attachment(transfer.filename);
      let totalSize: number | undefined = first.size;
      if (transfer.filename.endsWith('.zip')) {
        res.type('application/zip');
        const archive = archiver('zip', { store: true, forceZip64: true });
        const output = pipeline(archive, res);
        void output.catch(() => { archive.abort(); void cleanup(); });
        try {
          for (let index = 0; index < transfer.files.length; index++) {
            const file = transfer.files[index];
            const source = index === 0 ? first : await transfer.open(file);
            if (index > 0) totalSize = (totalSize ?? 0) + (source.size ?? 0);
            const done = finished(source.stream);
            archive.append(source.stream, { name: file.filename });
            await done;
          }
          await archive.finalize();
          await output;
        } catch (error) {
          archive.abort();
          res.destroy();
          await output.catch(() => undefined);
          throw error;
        }
      } else {
        res.type('video/mp4');
        if (first.size) res.setHeader('Content-Length', String(first.size));
        await pipeline(first.stream, res);
      }
      db.logDownload(req.user!.id, `${transfer.title} [converted]`, transfer.ratingKey, totalSize);
      logger.info('Converted download transferred', { userId: req.user!.id, ratingKey: transfer.ratingKey });
    } catch (error) { failure(res, error); }
    finally { await cleanup(); }
  });
  return { router, close: () => service.close() };
}
