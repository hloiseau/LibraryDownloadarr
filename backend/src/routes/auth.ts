import { Router } from 'express';
import bcrypt from 'bcrypt';
import { DatabaseService } from '../models/database';
import { PlexAuthFlows, exactServer, serverToken } from '../services/plexAuthFlow';
import { DownloadError } from '../services/downloadService';
import { logger } from '../utils/logger';
import { AuthRequest, createAuthMiddleware } from '../middleware/auth';

export const createAuthRouter = (db: DatabaseService, flows: PlexAuthFlows) => {
  const router = Router();
  const authMiddleware = createAuthMiddleware(db);

  // Check if initial setup is required
  router.get('/setup/required', (_req, res) => {
    const hasAdmin = db.hasAdminUser();
    return res.json({ setupRequired: !hasAdmin });
  });

  // Initial admin setup
  router.post('/setup', async (req, res) => {
    try {
      if (db.hasAdminUser()) {
        return res.status(400).json({ error: 'Setup already completed' });
      }

      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);
      if (db.hasAdminUser()) return res.status(400).json({ error: 'Setup already completed' });

      // Create admin user (email is optional, use username@localhost as default)
      const adminUser = db.createAdminUser({
        username,
        passwordHash,
        email: `${username}@localhost`,
        isAdmin: true,
      });

      // Create session
      const session = db.createSession(adminUser.id);

      logger.info(`Initial admin setup completed for user: ${username}`);

      return res.json({
        message: 'Setup completed successfully',
        user: {
          id: adminUser.id,
          username: adminUser.username,
          email: adminUser.email,
          isAdmin: adminUser.isAdmin,
        },
        token: session.token,
      });
    } catch (error) {
      logger.error('Setup error', { error });
      return res.status(500).json({ error: 'Setup failed' });
    }
  });

  // Admin login
  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      const user = db.getAdminUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      db.updateAdminLastLogin(user.id);
      const session = db.createSession(user.id);

      logger.info(`User logged in: ${username}`);

      return res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          isAdmin: user.isAdmin,
        },
        token: session.token,
      });
    } catch (error) {
      logger.error('Login error', { error });
      return res.status(500).json({ error: 'Login failed' });
    }
  });

  // The browser receives an unpredictable flow handle, never a Plex token.
  router.post('/plex/pin', async (_req, res) => {
    try { return res.json(await flows.start()); }
    catch (error) {
      return res.status(error instanceof DownloadError ? error.status : 502)
        .json({ error: error instanceof DownloadError ? error.message : 'Plex sign-in is unavailable. Try again.' });
    }
  });

  router.post('/plex/authenticate', async (req, res) => {
    try {
      const result = await flows.authorize(req.body.flowId);
      if (!result) return res.status(202).json({ pending: true });
      const machineId = db.getSetting('plex_machine_id');
      if (!machineId || !db.getSetting('plex_url')) {
        throw new DownloadError(503, 'The administrator must connect the Plex server in Settings first.');
      }
      const server = exactServer(result.servers, machineId);
      const plexUser = db.createOrUpdatePlexUser({
        username: result.auth.user.username, email: result.auth.user.email,
        plexToken: serverToken(server, result.auth.authToken), plexId: result.auth.user.uuid,
      });
      flows.consume(req.body.flowId);
      const session = db.createSession(plexUser.id);
      return res.json({ user: { id: plexUser.id, username: plexUser.username,
        email: plexUser.email, isAdmin: plexUser.isAdmin }, token: session.token });
    } catch (error) {
      return res.status(error instanceof DownloadError ? error.status : 502)
        .json({ error: error instanceof DownloadError ? error.message : 'Plex sign-in failed. Try again.' });
    }
  });

  // Get current user
  router.get('/me', authMiddleware, (req: AuthRequest, res) => {
    const { id, username, isAdmin } = req.user!;
    return res.json({ user: { id, username, isAdmin } });
  });

  // Logout
  router.post('/logout', authMiddleware, (req: AuthRequest, res) => {
    try {
      if (req.authSession?.token) {
        db.deleteSession(req.authSession.token);
      }
      return res.json({ message: 'Logged out successfully' });
    } catch (error) {
      logger.error('Logout error', { error });
      return res.status(500).json({ error: 'Logout failed' });
    }
  });

  // Change password (admin users only)
  router.post('/change-password', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current password and new password are required' });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters long' });
      }

      // Only admin users (those with password_hash) can change passwords
      // Plex users authenticate via OAuth and don't have passwords
      const user = db.getAdminUserById(req.user!.id);
      if (!user) {
        return res.status(400).json({ error: 'Password change is only available for admin accounts' });
      }

      // Verify current password
      const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isValid) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }

      // Hash new password
      const newPasswordHash = await bcrypt.hash(newPassword, 10);

      // Update password in database
      db.updateAdminPassword(user.id, newPasswordHash);

      logger.info(`Password changed for admin user: ${user.username}`);

      return res.json({ message: 'Password changed successfully' });
    } catch (error) {
      logger.error('Password change error', { error });
      return res.status(500).json({ error: 'Password change failed' });
    }
  });

  return router;
};
