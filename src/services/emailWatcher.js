import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isAuthenticated,
  getHistoryId,
  listHistory,
  getMessage,
  applyClassification,
  getRecentMessages
} from './gmail.js';
import logger from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.VERCEL ? '/tmp' : path.join(__dirname, '../../data');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed.json');

let watcherInterval = null;
let lastHistoryId = null;
let processedIds = new Set();
let stats = {
  totalProcessed: 0,
  important: 0,
  review: 0,
  junk: 0,
  errors: 0,
  lastRun: null,
  isRunning: false
};

async function loadProcessedIds() {
  try {
    const data = await fs.readFile(PROCESSED_FILE, 'utf8');
    const parsed = JSON.parse(data);
    processedIds = new Set(parsed.ids || []);
    lastHistoryId = parsed.historyId || null;
    logger.info(`Loaded ${processedIds.size} processed message IDs`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error('Error loading processed IDs:', error);
    }
    processedIds = new Set();
  }
}

async function saveProcessedIds() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  // Keep only last 10000 IDs to prevent unbounded growth
  const idsArray = Array.from(processedIds);
  if (idsArray.length > 10000) {
    const trimmed = idsArray.slice(-10000);
    processedIds = new Set(trimmed);
  }

  await fs.writeFile(PROCESSED_FILE, JSON.stringify({
    ids: Array.from(processedIds),
    historyId: lastHistoryId,
    savedAt: new Date().toISOString()
  }, null, 2));
}

async function processMessage(messageId) {
  if (processedIds.has(messageId)) {
    logger.debug(`Skipping already processed message: ${messageId}`);
    return null;
  }

  try {
    const email = await getMessage(messageId);

    // Skip if not in inbox (already processed or archived)
    if (!email.labelIds.includes('INBOX')) {
      processedIds.add(messageId);
      return null;
    }

    // Skip if already has our labels
    const ourLabels = ['AI-Important', 'AI-Review', 'AI-Junk'];
    if (email.labelIds.some(id => ourLabels.includes(id))) {
      processedIds.add(messageId);
      return null;
    }

    logger.info(`Processing: "${email.subject}" from ${email.from}`);

    const result = await classifyEmail(email);
    await applyClassification(messageId, result.classification);

    processedIds.add(messageId);
    stats.totalProcessed++;
    stats[result.classification.toLowerCase()]++;

    return {
      messageId,
      subject: email.subject,
      from: email.from,
      classification: result.classification,
      confidence: result.confidence,
      reason: result.reason
    };
  } catch (error) {
    logger.error(`Error processing message ${messageId}:`, error);
    stats.errors++;
    return null;
  }
}

async function poll() {
  if (!isAuthenticated()) {
    logger.warn('Not authenticated, skipping poll');
    return;
  }

  try {
    stats.lastRun = new Date().toISOString();
    let messagesToProcess = [];

    if (lastHistoryId) {
      // Incremental sync using history API
      const history = await listHistory(lastHistoryId);

      if (history === null) {
        // History too old, do full sync
        logger.info('History ID expired, doing full sync');
        lastHistoryId = null;
      } else if (history.history) {
        for (const item of history.history) {
          if (item.messagesAdded) {
            for (const added of item.messagesAdded) {
              messagesToProcess.push(added.message.id);
            }
          }
        }
        lastHistoryId = history.historyId;
      } else {
        // No new messages
        lastHistoryId = history.historyId;
      }
    }

    if (!lastHistoryId) {
      // Initial sync - get recent inbox messages
      const messages = await getRecentMessages(20);
      messagesToProcess = messages.map(m => m.id);
      lastHistoryId = await getHistoryId();
    }

    if (messagesToProcess.length > 0) {
      logger.info(`Processing ${messagesToProcess.length} messages`);

      for (const messageId of messagesToProcess) {
        await processMessage(messageId);
      }

      await saveProcessedIds();
    } else {
      logger.debug('No new messages to process');
    }
  } catch (error) {
    logger.error('Poll error:', error);
    stats.errors++;
  }
}

export async function startWatcher() {
  if (watcherInterval) {
    logger.warn('Watcher already running');
    return false;
  }

  if (!isAuthenticated()) {
    throw new Error('Not authenticated with Gmail');
  }

  await loadProcessedIds();

  const intervalMs = parseInt(process.env.POLL_INTERVAL_MS) || 60000;

  // Run immediately
  await poll();

  // Then schedule periodic polls
  watcherInterval = setInterval(poll, intervalMs);
  stats.isRunning = true;

  logger.info(`Email watcher started, polling every ${intervalMs / 1000}s`);
  return true;
}

export function stopWatcher() {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
    stats.isRunning = false;
    logger.info('Email watcher stopped');
    return true;
  }
  return false;
}

export function getWatcherStatus() {
  return {
    ...stats,
    processedCount: processedIds.size
  };
}

export function isWatcherRunning() {
  return watcherInterval !== null;
}

export { poll };
