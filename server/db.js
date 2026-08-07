'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('./sqlite');
const bcrypt = require('bcryptjs');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login_email   TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Business mailboxes. Only an administrator may create or edit these.
CREATE TABLE IF NOT EXISTS mailboxes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address        TEXT NOT NULL,
  display_name   TEXT NOT NULL DEFAULT '',
  imap_host      TEXT NOT NULL,
  imap_port      INTEGER NOT NULL DEFAULT 993,
  imap_secure    INTEGER NOT NULL DEFAULT 1,
  imap_user      TEXT NOT NULL,
  imap_password  TEXT NOT NULL,
  smtp_host      TEXT NOT NULL,
  smtp_port      INTEGER NOT NULL DEFAULT 465,
  smtp_secure    INTEGER NOT NULL DEFAULT 1,
  smtp_user      TEXT NOT NULL,
  smtp_password  TEXT NOT NULL,
  sent_folder    TEXT NOT NULL DEFAULT '',
  is_default     INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (address)
);
CREATE INDEX IF NOT EXISTS idx_mailboxes_user ON mailboxes(user_id);

-- One signature card per user. The layout is fixed for the whole company;
-- only these fields change per person.
CREATE TABLE IF NOT EXISTS signatures (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name    TEXT NOT NULL DEFAULT '',
  designation  TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  phone_type   TEXT NOT NULL DEFAULT 'call_sms_whatsapp'
                 CHECK (phone_type IN ('call_sms_whatsapp','call_sms','whatsapp')),
  meeting_link TEXT NOT NULL DEFAULT '',
  photo_file   TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Audit trail of everything sent through the platform.
CREATE TABLE IF NOT EXISTS sent_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id  INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
  to_addr     TEXT NOT NULL DEFAULT '',
  cc_addr     TEXT NOT NULL DEFAULT '',
  bcc_addr    TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  message_id  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'sent',
  error       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sent_log_user ON sent_log(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// ---------------------------------------------------------------------------
// First-run bootstrap: make sure exactly one administrator exists.
// ---------------------------------------------------------------------------
function bootstrap() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count > 0) return null;

  const password =
    config.bootstrapAdminPassword || require('crypto').randomBytes(9).toString('base64url');
  const info = db
    .prepare(
      `INSERT INTO users (login_email, password_hash, name, role, must_change_password)
       VALUES (?, ?, ?, 'admin', ?)`
    )
    .run(
      config.bootstrapAdminEmail.toLowerCase(),
      bcrypt.hashSync(password, 12),
      config.bootstrapAdminName,
      config.bootstrapAdminPassword ? 0 : 1
    );

  db.prepare('INSERT INTO signatures (user_id, full_name, designation) VALUES (?, ?, ?)').run(
    info.lastInsertRowid,
    config.bootstrapAdminName,
    'Administrator'
  );

  return { email: config.bootstrapAdminEmail, password, generated: !config.bootstrapAdminPassword };
}

/**
 * Make ADMIN_EMAIL / ADMIN_PASSWORD usable as a recovery route.
 *
 * bootstrap() only fires when the database is empty, which is no help on a
 * hosted deploy: the first start generates a password into a log nobody kept,
 * and there is no shell to run the seed script from. So whenever the
 * configured password is one that has not been applied yet, apply it — create
 * the administrator if missing, reset it if present.
 *
 * The applied value is remembered as a bcrypt hash, so restarting with the
 * same setting is a no-op and a password changed inside the app is left alone.
 * Changing the variable is what triggers a reset.
 */
function applyAdminPasswordFromEnv() {
  const password = config.bootstrapAdminPassword;
  if (!password) return null;

  const email = config.bootstrapAdminEmail.toLowerCase();
  const marker = getSetting('admin_env_password');
  const existing = db.prepare('SELECT id FROM users WHERE login_email = ?').get(email);

  if (existing && marker && bcrypt.compareSync(password, marker)) return null; // already applied

  const hash = bcrypt.hashSync(password, 12);
  let action;
  if (existing) {
    db.prepare(
      `UPDATE users SET password_hash = ?, role = 'admin', is_active = 1,
         must_change_password = 0, updated_at = datetime('now')
       WHERE id = ?`
    ).run(hash, existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    action = 'reset';
  } else {
    const info = db
      .prepare(
        `INSERT INTO users (login_email, password_hash, name, role, must_change_password)
         VALUES (?, ?, ?, 'admin', 0)`
      )
      .run(email, hash, config.bootstrapAdminName);
    db.prepare(
      'INSERT OR IGNORE INTO signatures (user_id, full_name, designation) VALUES (?, ?, ?)'
    ).run(info.lastInsertRowid, config.bootstrapAdminName, 'Administrator');
    action = 'created';
  }

  setSetting('admin_env_password', bcrypt.hashSync(password, 12));
  return { email, action };
}

function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

module.exports = { db, bootstrap, applyAdminPasswordFromEnv, purgeExpiredSessions };
