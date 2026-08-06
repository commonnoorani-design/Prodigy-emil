'use strict';

const { db } = require('../db');
const { decrypt } = require('../crypto');

/** Fields that are safe to hand back to the browser (never the passwords). */
const PUBLIC_COLUMNS = `id, user_id, address, display_name, imap_host, imap_port, imap_secure,
  imap_user, smtp_host, smtp_port, smtp_secure, smtp_user, sent_folder, is_default, is_active,
  last_checked_at, last_error, created_at`;

function listForUser(userId) {
  return db
    .prepare(
      `SELECT ${PUBLIC_COLUMNS} FROM mailboxes
       WHERE user_id = ? AND is_active = 1
       ORDER BY is_default DESC, address ASC`
    )
    .all(userId);
}

function listAll() {
  return db
    .prepare(
      `SELECT m.id, m.user_id, m.address, m.display_name, m.imap_host, m.imap_port, m.imap_secure,
              m.imap_user, m.smtp_host, m.smtp_port, m.smtp_secure, m.smtp_user, m.sent_folder,
              m.is_default, m.is_active, m.last_checked_at, m.last_error, m.created_at,
              u.name AS user_name, u.login_email AS user_login_email
       FROM mailboxes m JOIN users u ON u.id = m.user_id
       ORDER BY u.name ASC, m.address ASC`
    )
    .all();
}

function getPublic(id) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM mailboxes WHERE id = ?`).get(id);
}

/** Resolve a mailbox the given user is actually allowed to use. */
function getForUser(id, userId) {
  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM mailboxes WHERE id = ? AND user_id = ? AND is_active = 1`)
    .get(id, userId);
}

/** Full record including decrypted credentials — server side only. */
function getWithCredentials(id) {
  const row = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    imap_password_plain: decrypt(row.imap_password),
    smtp_password_plain: decrypt(row.smtp_password),
  };
}

function recordCheck(id, error) {
  db.prepare(
    `UPDATE mailboxes SET last_checked_at = datetime('now'), last_error = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(error ? String(error).slice(0, 400) : null, id);
}

module.exports = { PUBLIC_COLUMNS, listForUser, listAll, getPublic, getForUser, getWithCredentials, recordCheck };
