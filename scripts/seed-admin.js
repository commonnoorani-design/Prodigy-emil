#!/usr/bin/env node
'use strict';

/**
 * Create or reset an administrator account from the command line.
 *
 *   node scripts/seed-admin.js admin@prodigyeducations.com "Prodigy Administrator" [password]
 *
 * Useful when nobody can sign in any more — it never touches mailboxes or
 * signatures of existing users.
 */

const crypto = require('crypto');
const { db } = require('../server/db');
const auth = require('../server/auth');

const [, , emailArg, nameArg, passwordArg] = process.argv;

if (!emailArg) {
  console.error('Usage: node scripts/seed-admin.js <email> [name] [password]');
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();
const name = (nameArg || 'Prodigy Administrator').trim();
const password = passwordArg || crypto.randomBytes(9).toString('base64url');
const hash = auth.hashPassword(password);

const existing = db.prepare('SELECT id FROM users WHERE login_email = ?').get(email);

if (existing) {
  db.prepare(
    `UPDATE users SET password_hash = ?, role = 'admin', is_active = 1, must_change_password = 1,
       updated_at = datetime('now') WHERE id = ?`
  ).run(hash, existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`Reset administrator ${email}`);
} else {
  const info = db
    .prepare(
      `INSERT INTO users (login_email, password_hash, name, role, must_change_password)
       VALUES (?, ?, ?, 'admin', 1)`
    )
    .run(email, hash, name);
  db.prepare('INSERT INTO signatures (user_id, full_name, designation) VALUES (?, ?, ?)').run(
    info.lastInsertRowid,
    name,
    'Administrator'
  );
  console.log(`Created administrator ${email}`);
}

console.log(`Password: ${password}`);
console.log('The account must change this password at first sign-in.');
