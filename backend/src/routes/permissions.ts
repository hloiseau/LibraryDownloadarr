import { Router } from 'express';
import { DatabaseService } from '../models/database';
import { AuthRequest, createAuthMiddleware, createAdminMiddleware } from '../middleware/auth';
import { policyKey, readPolicy, validatePolicy } from '../services/downloadPolicy';
import { DownloadError } from '../services/downloadService';

export function createPermissionsRouter(db: DatabaseService) {
  const router = Router();
  router.use(createAuthMiddleware(db));
  router.get('/me', (req: AuthRequest, res) => res.json(readPolicy(db, req.user!)));
  router.use(createAdminMiddleware());
  router.get('/', (_req, res) => res.json({
    defaultPolicy: readPolicy(db, { id: 'default', isAdmin: false }),
    users: db.listPlexUsers().map(user => ({ id: user.id, username: user.username,
      custom: !!db.getSetting(policyKey(user.id)), policy: readPolicy(db, user) })),
  }));
  router.put('/:id', (req, res) => {
    try {
      if (req.params.id !== 'default' && !db.listPlexUsers().some(user => user.id === req.params.id)) {
        throw new DownloadError(404, 'User not found. The user must sign in with Plex first.');
      }
      if (req.body.inherit === true && req.params.id !== 'default') {
        db.setSetting(policyKey(req.params.id), '');
      } else {
        const policy = validatePolicy(req.body, db.getSetting('plex_machine_id') || '');
        db.setSetting(policyKey(req.params.id), JSON.stringify(policy));
      }
      return res.json({ saved: true });
    } catch (error) {
      return res.status(error instanceof DownloadError ? error.status : 500)
        .json({ error: error instanceof DownloadError ? error.message : 'Could not save permissions.' });
    }
  });
  return router;
}
