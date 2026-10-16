import { Router } from 'express';
import { AuthRequest, createAuthMiddleware } from '../middleware/auth';
import { DatabaseService } from '../models/database';
import { DOWNLOAD_PROFILES, DownloadError } from '../services/downloadService';
import { readPolicy } from '../services/downloadPolicy';
import { checkPlexConnection, PlexConnectionError } from '../services/plexConnection';

export function integrationBuildRevision(value = process.env.BUILD_REVISION): string | null {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
}

// A separate personal login is verified by immutable account/server identities.
// No Plex credential or application bearer is exchanged between applications.
export function createIntegrationsRouter(db: DatabaseService) {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/concierge', createAuthMiddleware(db), async (req: AuthRequest, res) => {
    try {
      if (Object.keys(req.query).length) throw new DownloadError(400, 'Integration identity does not accept filters.');
      const user = db.getPlexUserById(req.user!.id);
      const plexId = user?.plexId?.match(/^plex:([1-9][0-9]{0,18})$/)?.[1];
      if (!user?.plexToken || !plexId) throw new DownloadError(403, 'Sign in with your personal Plex account.');
      const serverId = db.getSetting('plex_machine_id');
      const serverUrl = db.getSetting('plex_url');
      if (!serverId || !serverUrl) throw new DownloadError(503, 'Plex server is not configured.');
      const policy = readPolicy(db, user);
      const qualities = Object.keys(DOWNLOAD_PROFILES).filter(quality => policy.qualities.includes(quality as keyof typeof DOWNLOAD_PROFILES));
      if (!policy.enabled || policy.libraries?.length === 0 || !qualities.length) throw new DownloadError(403, 'Conversions are not allowed for this account.');
      await checkPlexConnection(serverUrl, user.plexToken, serverId);
      // A logout, settings or credential change during source verification wins.
      const session = db.getSessionByToken(req.authSession!.token);
      const current = db.getPlexUserById(user.id);
      if (!session || session.userId !== user.id) throw new DownloadError(401, 'Session expired. Sign in again.');
      if (!current || current.plexId !== user.plexId || current.plexToken !== user.plexToken ||
          db.getSetting('plex_machine_id') !== serverId || db.getSetting('plex_url') !== serverUrl ||
          JSON.stringify(readPolicy(db, current)) !== JSON.stringify(policy)) {
        throw new DownloadError(403, 'Access changed. Verify your personal connection again.');
      }
      return res.json({ contractVersion: 1, buildRevision: integrationBuildRevision(),
        user: { plexId }, plexServerId: serverId, sessionExpiresAt: session.expiresAt,
        capabilities: { qualityOptions: qualities, streamOptions: true, preparedDownloads: true,
          singleUseTickets: true, queuePersistence: 'memory' } });
    } catch (error) {
      if (error instanceof PlexConnectionError) {
        return res.status(['HTTP_401', 'HTTP_403'].includes(error.code) ? 403 : 503)
          .json({ error: 'Personal Plex access could not be verified.' });
      }
      return res.status(error instanceof DownloadError ? error.status : 503)
        .json({ error: error instanceof DownloadError ? error.message : 'Integration temporarily unavailable.' });
    }
  });
  return router;
}
