'use strict';

const { db } = require('../db');
const { decrypt } = require('../crypto');

/** Fields that are safe to hand back to the browser (never the passwords). */
const PUBLIC_COLUMNS = `id, user_id, address, display_name, imap_host, imap_port, imap_secure,
  imap_user, smtp_host, smtp_port, smtp_secure, smtp_user, sent_folder, is_default, is_active,
  last_checked_at, last_error, created_at`;

const USER_COLUMNS = `m.id, m.user_id, m.address, m.display_name, m.imap_host, m.imap_port,
  m.imap_secure, m.imap_user, m.smtp_host, m.smtp_port, m.smtp_secure, m.smtp_user, m.sent_folder,
  m.is_active, m.last_checked_at, m.last_error, m.created_at`;

/**
 * Every mailbox this user may send and read from — their own and any shared
 * address they have been given access to. `is_default` is per user, so two
 * people sharing info@ can each have a different default sender.
 */
function listForUser(userId) {
  return db
    .prepare(
      `SELECT ${USER_COLUMNS}, a.is_default,
              (SELECT COUNT(*) FROM mailbox_access x WHERE x.mailbox_id = m.id) AS shared_with
       FROM mailbox_access a
       JOIN mailboxes m ON m.id = a.mailbox_id
       WHERE a.user_id = ? AND m.is_active = 1
       ORDER BY a.is_default DESC, m.address ASC`
    )
    .all(userId);
}

/** Admin view: every mailbox, with everyone who can use it. */
function listAll() {
  const rows = db
    .prepare(
      `SELECT m.id, m.user_id, m.address, m.display_name, m.imap_host, m.imap_port, m.imap_secure,
              m.imap_user, m.smtp_host, m.smtp_port, m.smtp_secure, m.smtp_user, m.sent_folder,
              m.is_active, m.last_checked_at, m.last_error, m.created_at,
              u.name AS user_name, u.login_email AS user_login_email
       FROM mailboxes m LEFT JOIN users u ON u.id = m.user_id
       ORDER BY m.address ASC`
    )
    .all();

  const access = db
    .prepare(
      `SELECT a.mailbox_id, a.user_id, a.is_default, u.name, u.login_email
       FROM mailbox_access a JOIN users u ON u.id = a.user_id
       ORDER BY u.name ASC`
    )
    .all();

  const byMailbox = new Map();
  for (const row of access) {
    if (!byMailbox.has(row.mailbox_id)) byMailbox.set(row.mailbox_id, []);
    byMailbox.get(row.mailbox_id).push({
      userId: row.user_id,
      name: row.name,
      loginEmail: row.login_email,
      isDefault: !!row.is_default,
    });
  }

  return rows.map((m) => ({ ...m, users: byMailbox.get(m.id) || [] }));
}

function getPublic(id) {
  const row = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM mailboxes WHERE id = ?`).get(id);
  if (!row) return null;
  return { ...row, userIds: userIdsFor(id) };
}

function userIdsFor(mailboxId) {
  return db
    .prepare('SELECT user_id FROM mailbox_access WHERE mailbox_id = ? ORDER BY user_id')
    .all(mailboxId)
    .map((r) => r.user_id);
}

/** Resolve a mailbox the given user is actually allowed to use. */
function getForUser(id, userId) {
  return db
    .prepare(
      `SELECT ${USER_COLUMNS}, a.is_default
       FROM mailbox_access a
       JOIN mailboxes m ON m.id = a.mailbox_id
       WHERE m.id = ? AND a.user_id = ? AND m.is_active = 1`
    )
    .get(id, userId);
}

/**
 * Replace the set of users who may use a mailbox.
 * `defaultFor` marks it as the default sender for those users who have no
 * other default yet — a first mailbox always becomes someone's default.
 */
function setUsers(mailboxId, userIds, { makeDefault = false } = {}) {
  const wanted = [...new Set(userIds.map(Number).filter(Boolean))];

  const apply = db.transaction(() => {
    const existing = new Set(userIdsFor(mailboxId));

    for (const userId of existing) {
      if (!wanted.includes(userId)) {
        db.prepare('DELETE FROM mailbox_access WHERE mailbox_id = ? AND user_id = ?').run(mailboxId, userId);
      }
    }

    for (const userId of wanted) {
      if (!existing.has(userId)) {
        db.prepare('INSERT INTO mailbox_access (mailbox_id, user_id) VALUES (?, ?)').run(mailboxId, userId);
      }

      const otherDefault = db
        .prepare(
          'SELECT COUNT(*) AS c FROM mailbox_access WHERE user_id = ? AND is_default = 1 AND mailbox_id != ?'
        )
        .get(userId, mailboxId).c;

      if (makeDefault) {
        db.prepare('UPDATE mailbox_access SET is_default = 0 WHERE user_id = ?').run(userId);
        db.prepare('UPDATE mailbox_access SET is_default = 1 WHERE mailbox_id = ? AND user_id = ?').run(mailboxId, userId);
      } else if (otherDefault === 0) {
        // Their only mailbox — nothing else could be the default.
        db.prepare('UPDATE mailbox_access SET is_default = 1 WHERE mailbox_id = ? AND user_id = ?').run(mailboxId, userId);
      }
    }

    // Keep the legacy owner column pointing at somebody who still has access.
    if (wanted.length) {
      const owner = db.prepare('SELECT user_id FROM mailboxes WHERE id = ?').get(mailboxId).user_id;
      if (!wanted.includes(owner)) {
        db.prepare('UPDATE mailboxes SET user_id = ? WHERE id = ?').run(wanted[0], mailboxId);
      }
    }
  });

  apply();
  return userIdsFor(mailboxId);
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

module.exports = {
  PUBLIC_COLUMNS,
  listForUser,
  listAll,
  getPublic,
  getForUser,
  setUsers,
  userIdsFor,
  getWithCredentials,
  recordCheck,
};
