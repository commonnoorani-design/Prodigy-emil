'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { db } = require('../db');
const auth = require('../auth');

const router = express.Router();

/**
 * First-run setup.
 *
 * When no ADMIN_PASSWORD is configured there is no way to hand someone the
 * first credentials: a generated password goes into a deployment log nobody
 * keeps, and this style of hosting has no shell to run a reset from. So if the
 * instance has no users at all, the first visitor creates the administrator
 * here. The moment one exists this route is closed for good.
 */
function needsSetup() {
  return db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0;
}

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes.' },
});

router.get('/status', (_req, res) => res.json({ needsSetup: needsSetup() }));

router.post('/', limiter, (req, res) => {
  if (!needsSetup()) {
    return res.status(409).json({ error: 'This site has already been set up. Sign in instead.' });
  }

  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!name) return res.status(400).json({ error: 'Your name is required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid sign-in email is required' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'Choose a password of at least 10 characters' });
  }

  const create = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO users (login_email, password_hash, name, role, must_change_password)
         VALUES (?, ?, ?, 'admin', 0)`
      )
      .run(email, auth.hashPassword(password), name);
    db.prepare('INSERT INTO signatures (user_id, full_name, designation) VALUES (?, ?, ?)').run(
      info.lastInsertRowid,
      name,
      'Administrator'
    );
    return info.lastInsertRowid;
  });

  let userId;
  try {
    userId = create();
  } catch (err) {
    // Two people hitting Create at once — one wins, the other is told to sign in.
    return res.status(409).json({ error: 'This site has already been set up. Sign in instead.' });
  }

  console.log(`[setup] Administrator ${email} created from the setup screen.`);

  const { token, expires } = auth.createSession(userId, req.get('user-agent') || '');
  auth.setSessionCookie(res, token, expires);
  res.status(201).json({
    user: { id: userId, name, loginEmail: email, role: 'admin', mustChangePassword: false },
  });
});

module.exports = { router, needsSetup };
