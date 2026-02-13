import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.VERCEL ? '/tmp' : path.join(__dirname, '../../data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey() {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('TOKEN_ENCRYPTION_KEY not set in environment variables');
  }
  // If key is hex string, convert to buffer; otherwise use as-is
  if (key.length === 64) {
    return Buffer.from(key, 'hex');
  }
  // Derive a 32-byte key from the provided string
  return crypto.scryptSync(key, 'email-filter-salt', 32);
}

function encrypt(data) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const jsonData = JSON.stringify(data);
  let encrypted = cipher.update(jsonData, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data: encrypted
  };
}

function decrypt(encryptedData) {
  const key = getEncryptionKey();
  const iv = Buffer.from(encryptedData.iv, 'hex');
  const authTag = Buffer.from(encryptedData.authTag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}

export async function saveTokens(tokens) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const encrypted = encrypt(tokens);
  await fs.writeFile(TOKENS_FILE, JSON.stringify(encrypted, null, 2));
}

export async function loadTokens() {
  // Try environment variable first (for Vercel)
  if (process.env.GMAIL_TOKENS) {
    try {
      const encrypted = JSON.parse(process.env.GMAIL_TOKENS);
      return decrypt(encrypted);
    } catch (error) {
      console.error('Failed to parse GMAIL_TOKENS environment variable', error);
      // Fall through to file try
    }
  }

  try {
    const data = await fs.readFile(TOKENS_FILE, 'utf8');
    const encrypted = JSON.parse(data);
    return decrypt(encrypted);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function clearTokens() {
  try {
    await fs.unlink(TOKENS_FILE);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function tokensExist() {
  try {
    await fs.access(TOKENS_FILE);
    return true;
  } catch {
    return false;
  }
}
