import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import { initializeGmail } from './services/gmail.js';
import { initializeOpenAI } from './services/classifier.js';
import { startWatcher } from './services/emailWatcher.js';
import logger from './logger.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/auth', authRoutes);
app.use('/api', apiRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Email Filter</title>
        <style>
          body { font-family: system-ui, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
          h1 { color: #1f2937; }
          a { color: #3b82f6; text-decoration: none; }
          a:hover { text-decoration: underline; }
          .card { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; }
          code { background: #e5e7eb; padding: 2px 6px; border-radius: 4px; }
        </style>
      </head>
      <body>
        <h1>📧 Email Filter</h1>
        <p>AI-powered email classification using Gmail API and GPT-4o-mini.</p>

        <div class="card">
          <h3>Quick Start</h3>
          <ol>
            <li><a href="/auth/google">Connect Gmail Account</a></li>
            <li><a href="/api/status">Check Status</a></li>
            <li>Start the watcher: <code>POST /api/watcher/start</code></li>
          </ol>
        </div>

        <div class="card">
          <h3>API Endpoints</h3>
          <ul>
            <li><code>GET /auth/google</code> - Start OAuth flow</li>
            <li><code>GET /auth/status</code> - Check authentication status</li>
            <li><code>GET /api/status</code> - Full system status</li>
            <li><code>POST /api/watcher/start</code> - Start email monitoring</li>
            <li><code>POST /api/watcher/stop</code> - Stop email monitoring</li>
            <li><code>GET /api/emails/recent</code> - View recent emails</li>
            <li><code>GET /api/health</code> - Health check</li>
          </ul>
        </div>

        <div class="card">
          <h3>Classification Labels</h3>
          <ul>
            <li><strong>AI-Important</strong> - Personal, work, financial, security emails (stays in inbox)</li>
            <li><strong>AI-Review</strong> - Newsletters, notifications, uncertain (moved from inbox)</li>
            <li><strong>AI-Junk</strong> - Spam, scams, unsolicited marketing (moved from inbox)</li>
          </ul>
        </div>
      </body>
    </html>
  `);
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Startup logic
let initialized = false;

async function initialize() {
  if (initialized) return;

  // Validate required environment variables
  const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    logger.warn(`Missing environment variables: ${missing.join(', ')}`);
    logger.warn('Some features may not work until these are configured.');
  }

  // Initialize OpenAI if key is present
  if (process.env.OPENAI_API_KEY) {
    try {
      initializeOpenAI();
    } catch (error) {
      logger.error('Failed to initialize OpenAI:', error);
    }
  } else {
    logger.warn('OPENAI_API_KEY not set - classification will not work');
  }

  // Try to initialize Gmail with stored tokens
  try {
    const isReady = await initializeGmail();
    if (isReady) {
      logger.info('Gmail initialized with stored tokens');

      // Auto-start watcher only if configured AND not in Vercel (Cron handles it there)
      if (process.env.AUTO_START_WATCHER === 'true' && !process.env.VERCEL) {
        await startWatcher();
      }
    }
  } catch (error) {
    logger.warn('Could not initialize Gmail:', error.message);
    logger.info('Visit /auth/google to authenticate');
  }

  initialized = true;
}

// Lazy initialization for Vercel
app.use(async (req, res, next) => {
  if (!initialized) {
    await initialize();
  }
  next();
});

// Start server if running directly
if (process.env.VERCEL !== '1') {
  initialize().then(() => {
    app.listen(PORT, () => {
      logger.info(`Email filter server running on http://localhost:${PORT}`);
      logger.info(`Authenticate at http://localhost:${PORT}/auth/google`);
    });
  }).catch(error => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

export default app;
