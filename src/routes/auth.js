import { Router } from 'express';
import { getAuthUrl, handleAuthCallback, isAuthenticated, getProfile } from '../services/gmail.js';
import { clearTokens } from '../services/tokenStorage.js';
import logger from '../logger.js';

const router = Router();

// Start OAuth flow
router.get('/google', (req, res) => {
  const authUrl = getAuthUrl();
  logger.info('Redirecting to Google OAuth');
  res.redirect(authUrl);
});

// OAuth callback
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    logger.error('OAuth error:', error);
    return res.status(400).send(`Authentication error: ${error}`);
  }

  if (!code) {
    return res.status(400).send('No authorization code received');
  }

  try {
    await handleAuthCallback(code);
    logger.info('OAuth successful');

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authentication Successful</title>
          <style>
            body { font-family: system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .success { color: #22c55e; }
            a { color: #3b82f6; }
          </style>
        </head>
        <body>
          <h1 class="success">✓ Authentication Successful</h1>
          <p>Your Gmail account has been connected. The email filter is ready to start.</p>
          <p>
            <a href="/api/status">View Status</a> |
            <a href="/api/watcher/start" onclick="fetch('/api/watcher/start', {method:'POST'}).then(()=>location.reload()); return false;">Start Watcher</a>
          </p>
        </body>
      </html>
    `);
  } catch (err) {
    logger.error('OAuth callback error:', err);
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

// Check auth status
router.get('/status', async (req, res) => {
  try {
    if (!isAuthenticated()) {
      return res.json({ authenticated: false });
    }

    const profile = await getProfile();
    res.json({
      authenticated: true,
      email: profile.emailAddress,
      messagesTotal: profile.messagesTotal
    });
  } catch (error) {
    res.json({ authenticated: false, error: error.message });
  }
});

// Logout
router.post('/logout', async (req, res) => {
  try {
    await clearTokens();
    logger.info('Logged out, tokens cleared');
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
