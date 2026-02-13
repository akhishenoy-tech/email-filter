import { google } from 'googleapis';
import { loadTokens, saveTokens } from './tokenStorage.js';
import logger from '../logger.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

const LABELS = {
  IMPORTANT: 'AI-Important',
  REVIEW: 'AI-Review',
  JUNK: 'AI-Junk'
};

let oauth2Client = null;
let gmail = null;
let labelIds = {};

export function getOAuth2Client() {
  if (!oauth2Client) {
    oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.on('tokens', async (tokens) => {
      if (tokens.refresh_token) {
        const existingTokens = await loadTokens();
        await saveTokens({ ...existingTokens, ...tokens });
        logger.info('Tokens refreshed and saved');
      }
    });
  }
  return oauth2Client;
}

export function getAuthUrl() {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
}

export async function handleAuthCallback(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  await saveTokens(tokens);
  await initializeGmail();
  return tokens;
}

export async function initializeGmail() {
  const client = getOAuth2Client();
  const tokens = await loadTokens();

  if (!tokens) {
    logger.warn('No tokens found, authentication required');
    return false;
  }

  client.setCredentials(tokens);
  gmail = google.gmail({ version: 'v1', auth: client });

  // Ensure custom labels exist
  await ensureLabels();

  logger.info('Gmail API initialized');
  return true;
}

export function getGmailClient() {
  return gmail;
}

export function isAuthenticated() {
  return gmail !== null;
}

async function ensureLabels() {
  if (!gmail) return;

  try {
    const { data } = await gmail.users.labels.list({ userId: 'me' });
    const existingLabels = data.labels || [];

    for (const [key, labelName] of Object.entries(LABELS)) {
      const existing = existingLabels.find(l => l.name === labelName);

      if (existing) {
        labelIds[key] = existing.id;
        logger.info(`Label "${labelName}" already exists with ID: ${existing.id}`);
      } else {
        const { data: newLabel } = await gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name: labelName,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show'
          }
        });
        labelIds[key] = newLabel.id;
        logger.info(`Created label "${labelName}" with ID: ${newLabel.id}`);
      }
    }
  } catch (error) {
    logger.error('Error ensuring labels:', error);
    throw error;
  }
}

export function getLabelIds() {
  return labelIds;
}

export async function getProfile() {
  if (!gmail) throw new Error('Gmail not initialized');
  const { data } = await gmail.users.getProfile({ userId: 'me' });
  return data;
}

export async function getHistoryId() {
  const profile = await getProfile();
  return profile.historyId;
}

export async function listHistory(startHistoryId) {
  if (!gmail) throw new Error('Gmail not initialized');

  try {
    const { data } = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded']
    });
    return data;
  } catch (error) {
    if (error.code === 404) {
      // History ID is too old, need to do a full sync
      return null;
    }
    throw error;
  }
}

export async function getMessage(messageId) {
  if (!gmail) throw new Error('Gmail not initialized');

  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });

  return parseMessage(data);
}

function parseMessage(message) {
  const headers = message.payload.headers;
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  let body = '';

  // Extract body from parts
  function extractBody(parts) {
    if (!parts) return '';
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
      if (part.parts) {
        const result = extractBody(part.parts);
        if (result) return result;
      }
    }
    return '';
  }

  if (message.payload.body?.data) {
    body = Buffer.from(message.payload.body.data, 'base64').toString('utf8');
  } else if (message.payload.parts) {
    body = extractBody(message.payload.parts);
  }

  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds || [],
    from: getHeader('From'),
    to: getHeader('To'),
    subject: getHeader('Subject'),
    date: getHeader('Date'),
    snippet: message.snippet,
    body: body
  };
}

export async function modifyLabels(messageId, addLabelIds, removeLabelIds) {
  if (!gmail) throw new Error('Gmail not initialized');

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: addLabelIds || [],
      removeLabelIds: removeLabelIds || []
    }
  });

  logger.info(`Modified labels for message ${messageId}: +${addLabelIds} -${removeLabelIds}`);
}

export async function trashMessage(messageId) {
  if (!gmail) throw new Error('Gmail not initialized');

  await gmail.users.messages.trash({
    userId: 'me',
    id: messageId
  });

  logger.info(`Trashed message ${messageId}`);
}

export async function applyClassification(messageId, classification) {
  // For JUNK, delete the email entirely
  if (classification === 'JUNK') {
    await trashMessage(messageId);
    return { action: 'trashed' };
  }

  const labelId = labelIds[classification];
  if (!labelId) {
    throw new Error(`Unknown classification: ${classification}`);
  }

  const addLabels = [labelId];
  const removeLabels = [];

  // For IMPORTANT, keep in inbox
  // For REVIEW, remove from inbox
  if (classification === 'REVIEW') {
    removeLabels.push('INBOX');
  }

  await modifyLabels(messageId, addLabels, removeLabels);
  return { addLabels, removeLabels };
}

export async function getRecentMessages(maxResults = 10) {
  if (!gmail) throw new Error('Gmail not initialized');

  const { data } = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: 'in:inbox'
  });

  if (!data.messages) return [];

  const messages = await Promise.all(
    data.messages.map(m => getMessage(m.id))
  );

  return messages;
}
