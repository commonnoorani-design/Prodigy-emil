'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { db } = require('../db');
const auth = require('../auth');
const config = require('../config');
const mailboxes = require('../mail/mailboxes');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
});

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    loginEmail: user.login_email,
    role: user.role,
    mustChangePassword: !!user.must_change_password,
  };
}

router.post('/login', loginLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE login_email = ?').get(email);
  if (!user || !user.is_active || !auth.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  const { token, expires } = auth.createSession(user.id, req.get('user-agent') || '');
  auth.setSessionCookie(res, token, expires);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  auth.destroySession(req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  // Say which kind of "not signed in" this is. A browser that never kept the
  // cookie and a session the server no longer has look identical from the
  // page, and they call for opposite fixes, so name them apart here.
  if (!req.user) {
    return res.status(401).json({
      error: 'Not signed in',
      reason: req.sessionToken ? 'unknown_session' : 'no_cookie',
    });
  }
  const signature = db.prepare('SELECT * FROM signatures WHERE user_id = ?').get(req.user.id) || null;
  res.json({
    user: publicUser(req.user),
    signature,
    mailboxes: mailboxes.listForUser(req.user.id),
    brand: {
      name: config.brand.name,
      tagline: config.brand.tagline,
      website: config.brand.website,
      websiteLabel: config.brand.websiteLabel,
      supportEmail: config.brand.supportEmail,
      whatsapp: config.brand.whatsapp,
      established: config.brand.established,
    },
  });
});

router.post('/password', auth.requireAuth, (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (next.length < 10) {
    return res.status(400).json({ error: 'New password must be at least 10 characters' });
  }
  if (!auth.verifyPassword(current, req.user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`
  ).run(auth.hashPassword(next), req.user.id);
  // Every other session for this account is invalidated.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  const { token, expires } = auth.createSession(req.user.id, req.get('user-agent') || '');
  auth.setSessionCookie(res, token, expires);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API tokens — how an AI assistant connects without being handed a password.
// A token acts as its owner for mail and signature routes only.
// ---------------------------------------------------------------------------
router.get('/tokens', auth.requireAuth, (req, res) => {
  res.json({ tokens: auth.listApiTokens(req.user.id) });
});

router.post('/tokens', auth.requireAuth, (req, res) => {
  if (req.viaApiToken) {
    return res.status(403).json({ error: 'A token cannot mint another token' });
  }
  const name = String(req.body.name || '').trim() || 'AI assistant';
  if (auth.listApiTokens(req.user.id).length >= 10) {
    return res.status(400).json({ error: 'You already have 10 tokens — revoke one first' });
  }
  const { id, token } = auth.createApiToken(req.user.id, name);
  // Shown exactly once; only its hash is kept.
  res.status(201).json({ id, name, token });
});

router.delete('/tokens/:id', auth.requireAuth, (req, res) => {
  const ok = auth.revokeApiToken(req.user.id, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Token not found' });
  res.json({ ok: true });
});

module.exports = { router, publicUser };
