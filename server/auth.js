'use strict';

const bcrypt = require('bcryptjs');
const config = require('./config');
const { db } = require('./db');
const { randomToken, hashToken } = require('./crypto');

const COOKIE = 'pe_session';

function createSession(userId, userAgent = '') {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)'
  ).run(hashToken(token), userId, expires.toISOString().replace('T', ' ').slice(0, 19), userAgent.slice(0, 250));
  return { token, expires };
}

function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

function setSessionCookie(res, token, expires) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    expires,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

const TOKEN_PREFIX = 'pem_';

function createApiToken(userId, name) {
  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  const info = db
    .prepare('INSERT INTO api_tokens (user_id, name, token_hash) VALUES (?, ?, ?)')
    .run(userId, String(name || '').slice(0, 60), hashToken(token));
  return { id: info.lastInsertRowid, token };
}

function listApiTokens(userId) {
  return db
    .prepare('SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC')
    .all(userId);
}

function revokeApiToken(userId, id) {
  return db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

/** Resolve an `Authorization: Bearer pem_…` header to its owner. */
function userFromApiToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match || !match[1].startsWith(TOKEN_PREFIX)) return null;

  const row = db
    .prepare(
      `SELECT u.*, t.id AS api_token_id FROM api_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND u.is_active = 1`
    )
    .get(hashToken(match[1]));
  if (!row) return null;

  db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.api_token_id);
  return row;
}

function currentUser(req) {
  const token = req.cookies ? req.cookies[COOKIE] : null;
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.is_active = 1`
    )
    .get(hashToken(token));
  return row || null;
}

function attachUser(req, _res, next) {
  const viaToken = userFromApiToken(req);
  req.user = viaToken || currentUser(req);
  req.viaApiToken = Boolean(viaToken);
  req.sessionToken = req.cookies ? req.cookies[COOKIE] : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (req.viaApiToken) {
    return res.status(403).json({ error: 'API tokens cannot be used for administration' });
  }
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
  next();
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

module.exports = {
  COOKIE,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  requireAdmin,
  verifyPassword,
  hashPassword,
};
