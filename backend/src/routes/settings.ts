import axios from 'axios';
import { PlexAuthFlows, normalizePlexUrl } from '../services/plexAuthFlow';
import { DownloadError } from '../services/downloadService';
import { Router } from 'express';
import { DatabaseService } from '../models/database';
import { plexService } from '../services/plexService';
import { logger } from '../utils/logger';
import { AuthRequest, createAuthMiddleware, createAdminMiddleware } from '../middleware/auth';

export const createSettingsRouter = (db: DatabaseService, flows: PlexAuthFlows) => {
  const router = Router();
  const authMiddleware = createAuthMiddleware(db);
  const adminMiddleware = createAdminMiddleware();

  // Get settings (admin only)
  router.get('/', authMiddleware, adminMiddleware, (_req: AuthRequest, res) => {
    try {
      const plexUrl = db.getSetting('plex_url') || '';
      const plexToken = db.getSetting('plex_token') || '';
      const plexMachineId = db.getSetting('plex_machine_id') || '';
      const plexServerName = db.getSetting('plex_server_name') || '';

      return res.json({
        settings: {
          plexUrl,
          hasPlexToken: !!plexToken,
          plexMachineId,
          plexServerName,
        },
      });
    } catch (error) {
      logger.error('Failed to get settings', { error });
      return res.status(500).json({ error: 'Failed to get settings' });
    }
  });

  const saveConnection = (connection: { url: string; token: string; machineId: string; name: string }) => {
    const previous = db.getSetting('plex_machine_id');
    if (previous !== connection.machineId) db.invalidatePlexSessions();
    db.setSetting('plex_url', connection.url);
    db.setSetting('plex_token', connection.token);
    db.setSetting('plex_machine_id', connection.machineId);
    db.setSetting('plex_server_name', connection.name);
    plexService.setServerConnection(connection.url, connection.token);
  };
  const fail = (res: any, error: unknown) => res.status(error instanceof DownloadError ? error.status : 502)
    .json({ error: error instanceof DownloadError ? error.message : 'Cannot connect to Plex. Check that the server address is reachable from LibraryDownloadarr.' });

  router.post('/plex/connect', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
    try { return res.json(await flows.start(req.authSession!.id)); }
    catch (error) { return fail(res, error); }
  });
  router.post('/plex/servers', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
    try {
      const servers = await flows.ownedServers(req.body.flowId, req.authSession!.id);
      return servers === null ? res.status(202).json({ pending: true }) : res.json({ servers });
    } catch (error) { return fail(res, error); }
  });
  router.post('/plex/select', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
    try {
      const connection = await flows.configure(req.body.flowId, req.authSession!.id, req.body.serverId, req.body.url);
      saveConnection(connection);
      return res.json({ connected: true, name: connection.name });
    } catch (error) { return fail(res, error); }
  });

  // Advanced manual configuration remains available for existing installations.
  router.put('/', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
    try {
      const url = normalizePlexUrl(req.body.plexUrl || db.getSetting('plex_url') || '');
      const token = req.body.plexToken || db.getSetting('plex_token');
      if (typeof token !== 'string' || !token) throw new DownloadError(400, 'Connect with Plex or supply a server token.');
      const client = axios.create({ baseURL: url, timeout: 10000, maxRedirects: 0,
        headers: { Accept: 'application/json', 'X-Plex-Token': token } });
      const identity = (await client.get('/identity')).data.MediaContainer;
      if (!identity?.machineIdentifier) throw new DownloadError(502, 'Plex did not return a server identity.');
      const sections = (await client.get('/library/sections')).data.MediaContainer;
      saveConnection({ url, token, machineId: identity.machineIdentifier, name: sections?.friendlyName || identity.friendlyName || 'Plex server' });
      return res.json({ message: 'Settings saved successfully' });
    } catch (error) { return fail(res, error); }
  });
  router.post('/test-connection', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
    try {
      const url = normalizePlexUrl(req.body.plexUrl || db.getSetting('plex_url') || '');
      const token = req.body.plexToken || db.getSetting('plex_token');
      if (!token) throw new DownloadError(400, 'Connect with Plex first.');
      await axios.get(`${url}/library/sections`, { timeout: 10000, maxRedirects: 0,
        headers: { Accept: 'application/json', 'X-Plex-Token': token } });
      return res.json({ connected: true });
    } catch (error) { return fail(res, error); }
  });

  return router;
};
