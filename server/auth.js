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
  req.user = currentUser(req);
  req.sessionToken = req.cookies ? req.cookies[COOKIE] : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
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
