import { Router } from 'express';
import { isAuthenticated, getProfile, getLabelIds, getRecentMessages } from '../services/gmail.js';
import { startWatcher, stopWatcher, getWatcherStatus, isWatcherRunning } from '../services/emailWatcher.js';
import { isOpenAIReady } from '../services/classifier.js';
import logger from '../logger.js';

const router = Router();

// Get overall status
router.get('/status', async (req, res) => {
  try {
    const watcherStatus = getWatcherStatus();
    let authStatus = { authenticated: false };

    if (isAuthenticated()) {
      try {
        const profile = await getProfile();
        authStatus = {
          authenticated: true,
          email: profile.emailAddress
        };
      } catch (error) {
        authStatus = { authenticated: false, error: error.message };
      }
    }

    res.json({
      auth: authStatus,
      openai: { ready: isOpenAIReady() },
      watcher: watcherStatus,
      labels: getLabelIds()
    });
  } catch (error) {
    logger.error('Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start the email watcher
router.post('/watcher/start', async (req, res) => {
  try {
    if (isWatcherRunning()) {
      return res.json({ success: true, message: 'Watcher already running' });
    }

    await startWatcher();
    res.json({ success: true, message: 'Watcher started' });
  } catch (error) {
    logger.error('Start watcher error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Trigger a single poll (for Cron)
router.get('/watcher/poll', async (req, res) => {
  try {
    if (isWatcherRunning()) {
      return res.json({ success: true, message: 'Watcher already running' });
    }

    // Check for auth header to prevent unauthorized access if needed
    // For now, we assume Vercel Cron protection or open access

    await poll();
    const stats = getWatcherStatus();

    res.json({
      success: true,
      message: 'Poll completed',
      stats: {
        processed: stats.totalProcessed,
        lastRun: stats.lastRun
      }
    });
  } catch (error) {
    logger.error('Poll error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stop the email watcher
router.post('/watcher/stop', (req, res) => {
  try {
    const stopped = stopWatcher();
    res.json({
      success: true,
      message: stopped ? 'Watcher stopped' : 'Watcher was not running'
    });
  } catch (error) {
    logger.error('Stop watcher error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get recent emails (for debugging)
router.get('/emails/recent', async (req, res) => {
  try {
    if (!isAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const count = Math.min(parseInt(req.query.count) || 10, 50);
    const messages = await getRecentMessages(count);

    res.json({
      count: messages.length,
      messages: messages.map(m => ({
        id: m.id,
        from: m.from,
        subject: m.subject,
        date: m.date,
        snippet: m.snippet,
        labels: m.labelIds
      }))
    });
  } catch (error) {
    logger.error('Get emails error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
