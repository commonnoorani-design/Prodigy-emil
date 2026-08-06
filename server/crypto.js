'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let cachedKey = null;

/**
 * When SECRET_KEY is not configured, mint one on first use and keep it in
 * data/secret.key (owner-readable only). That way a fresh install encrypts
 * mailbox passwords under a key unique to that server, with no setup step —
 * and the key survives restarts, which is what actually matters.
 */
function keyFromDisk() {
  const file = path.join(config.dataDir, 'secret.key');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* not created yet */
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  console.log(`[setup] Generated a new encryption key at ${file} — back this file up.`);
  return generated;
}

// Accepts a 64-char hex string, a 44-char base64 string, or any passphrase
// (hashed to 32 bytes).
function key() {
  if (cachedKey) return cachedKey;
  const raw = config.secretKey || keyFromDisk();
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'base64');
  } else {
    cachedKey = crypto.createHash('sha256').update(raw, 'utf8').digest();
  }
  return cachedKey;
}

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(payload) {
  if (!payload) return '';
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Stored credential is malformed');
  }
  const [, iv, tag, data] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Resolve (and if needed create) the encryption key ahead of first use. */
function ensureKey() {
  key();
}

module.exports = { encrypt, decrypt, randomToken, hashToken, ensureKey };
