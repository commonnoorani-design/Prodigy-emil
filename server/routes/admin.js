'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const { db, maintenance } = require('../db');
const auth = require('../auth');
const { encrypt } = require('../crypto');
const mailboxStore = require('../mail/mailboxes');
const imap = require('../mail/imap');
const smtp = require('../mail/smtp');

const router = express.Router();
router.use(auth.requireAdmin);

function bad(res, message) {
  return res.status(400).json({ error: message });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
router.get('/users', (_req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.login_email, u.name, u.role, u.is_active, u.must_change_password, u.created_at,
              (SELECT COUNT(*) FROM mailboxes m WHERE m.user_id = u.id AND m.is_active = 1) AS mailbox_count,
              s.designation, s.photo_file
       FROM users u LEFT JOIN signatures s ON s.user_id = u.id
       ORDER BY u.role DESC, u.name ASC`
    )
    .all();
  res.json({ users });
});

router.post('/users', (req, res) => {
  const email = String(req.body.loginEmail || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const designation = String(req.body.designation || '').trim();
  let password = String(req.body.password || '');

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'A valid sign-in email is required');
  if (!name) return bad(res, 'Name is required');
  if (password && password.length < 10) return bad(res, 'Password must be at least 10 characters');

  const generated = !password;
  if (generated) password = crypto.randomBytes(9).toString('base64url');

  const exists = db.prepare('SELECT id FROM users WHERE login_email = ?').get(email);
  if (exists) return bad(res, 'A user with that sign-in email already exists');

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO users (login_email, password_hash, name, role, must_change_password)
         VALUES (?, ?, ?, ?, 1)`
      )
      .run(email, auth.hashPassword(password), name, role);
    db.prepare(
      'INSERT INTO signatures (user_id, full_name, designation, email) VALUES (?, ?, ?, ?)'
    ).run(info.lastInsertRowid, name, designation, '');
    return info.lastInsertRowid;
  });

  const id = tx();
  res.status(201).json({ id, temporaryPassword: password, generated });
});

router.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const updates = [];
  const values = [];

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return bad(res, 'Name cannot be empty');
    updates.push('name = ?');
    values.push(name);
  }
  if (req.body.role !== undefined) {
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    if (user.role === 'admin' && role !== 'admin' && adminCount() <= 1) {
      return bad(res, 'At least one administrator must remain');
    }
    updates.push('role = ?');
    values.push(role);
  }
  if (req.body.isActive !== undefined) {
    const active = req.body.isActive ? 1 : 0;
    if (!active && user.role === 'admin' && adminCount() <= 1) {
      return bad(res, 'At least one active administrator must remain');
    }
    if (!active && user.id === req.user.id) return bad(res, 'You cannot deactivate your own account');
    updates.push('is_active = ?');
    values.push(active);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }

  if (updates.length) {
    values.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);
  }
  res.json({ ok: true });
});

router.post('/users/:id/password', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let password = String(req.body.password || '');
  const generated = !password;
  if (generated) password = crypto.randomBytes(9).toString('base64url');
  else if (password.length < 10) return bad(res, 'Password must be at least 10 characters');

  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?`
  ).run(auth.hashPassword(password), id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ temporaryPassword: password, generated });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) return bad(res, 'You cannot delete your own account');
  if (user.role === 'admin' && adminCount() <= 1) return bad(res, 'At least one administrator must remain');
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

function adminCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1").get().c;
}

// ---------------------------------------------------------------------------
// Business mailboxes — assignment is administrator-only by design.
// ---------------------------------------------------------------------------
router.get('/mailboxes', (_req, res) => {
  res.json({ mailboxes: mailboxStore.listAll() });
});

function readMailboxBody(body, { requirePasswords }) {
  const address = String(body.address || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return { error: 'A valid business email address is required' };

  const imapHost = String(body.imapHost || '').trim();
  const smtpHost = String(body.smtpHost || '').trim();
  if (!imapHost) return { error: 'IMAP host is required' };
  if (!smtpHost) return { error: 'SMTP host is required' };

  const imapPassword = String(body.imapPassword || '');
  const smtpPassword = String(body.smtpPassword || body.imapPassword || '');
  if (requirePasswords && !imapPassword) return { error: 'Mailbox password is required' };

  return {
    values: {
      address,
      display_name: String(body.displayName || '').trim(),
      imap_host: imapHost,
      imap_port: Number(body.imapPort) || 993,
      imap_secure: body.imapSecure === false || body.imapSecure === 'false' ? 0 : 1,
      imap_user: String(body.imapUser || address).trim(),
      smtp_host: smtpHost,
      smtp_port: Number(body.smtpPort) || 465,
      smtp_secure: body.smtpSecure === false || body.smtpSecure === 'false' ? 0 : 1,
      smtp_user: String(body.smtpUser || body.imapUser || address).trim(),
      sent_folder: String(body.sentFolder || '').trim(),
      is_default: body.isDefault ? 1 : 0,
    },
    imapPassword,
    smtpPassword,
  };
}

/**
 * Who should be able to use this mailbox? Accepts `userIds` (an array, for a
 * shared address) and still understands a single `userId` from older callers.
 */
function readAssignees(body) {
  const raw = Array.isArray(body.userIds) ? body.userIds : body.userId ? [body.userId] : [];
  const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return { error: 'Choose at least one person who can use this email' };

  const known = db
    .prepare(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids)
    .map((r) => r.id);
  const missing = ids.filter((id) => !known.includes(id));
  if (missing.length) return { error: 'One of the selected users no longer exists' };

  return { ids };
}

router.post('/mailboxes', (req, res) => {
  const assignees = readAssignees(req.body);
  if (assignees.error) return bad(res, assignees.error);

  const parsed = readMailboxBody(req.body, { requirePasswords: true });
  if (parsed.error) return bad(res, parsed.error);

  const taken = db.prepare('SELECT id FROM mailboxes WHERE address = ?').get(parsed.values.address);
  if (taken) {
    return bad(res, 'That business email already exists — edit it to share it with more people');
  }

  const v = parsed.values;
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO mailboxes
          (user_id, address, display_name, imap_host, imap_port, imap_secure, imap_user, imap_password,
           smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, sent_folder, is_default)
         VALUES (@user_id, @address, @display_name, @imap_host, @imap_port, @imap_secure, @imap_user, @imap_password,
                 @smtp_host, @smtp_port, @smtp_secure, @smtp_user, @smtp_password, @sent_folder, @is_default)`
      )
      .run({
        ...v,
        user_id: assignees.ids[0],
        imap_password: encrypt(parsed.imapPassword),
        smtp_password: encrypt(parsed.smtpPassword || parsed.imapPassword),
      });
    return info.lastInsertRowid;
  });

  const id = tx();
  mailboxStore.setUsers(id, assignees.ids, { makeDefault: Boolean(v.is_default) });

  // Keep each holder's signature contact email in step, where they have none.
  for (const userId of assignees.ids) {
    db.prepare(
      `UPDATE signatures SET email = ?, updated_at = datetime('now')
       WHERE user_id = ? AND (email IS NULL OR email = '')`
    ).run(parsed.values.address, userId);
  }

  res.status(201).json({ id, mailbox: mailboxStore.getPublic(id) });
});

router.patch('/mailboxes/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Mailbox not found' });

  const parsed = readMailboxBody({ ...req.body, address: req.body.address || existing.address }, { requirePasswords: false });
  if (parsed.error) return bad(res, parsed.error);

  const v = parsed.values;
  const wantsAssignees = req.body.userIds !== undefined || req.body.userId !== undefined;
  let assignees = null;
  if (wantsAssignees) {
    assignees = readAssignees(req.body);
    if (assignees.error) return bad(res, assignees.error);
  }
  const ownerId = assignees ? assignees.ids[0] : existing.user_id;
  if (v.address !== existing.address) {
    const taken = db.prepare('SELECT id FROM mailboxes WHERE address = ? AND id != ?').get(v.address, id);
    if (taken) return bad(res, 'That business email is already assigned');
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE mailboxes SET user_id = @user_id, address = @address, display_name = @display_name,
        imap_host = @imap_host, imap_port = @imap_port, imap_secure = @imap_secure, imap_user = @imap_user,
        smtp_host = @smtp_host, smtp_port = @smtp_port, smtp_secure = @smtp_secure, smtp_user = @smtp_user,
        sent_folder = @sent_folder, is_default = @is_default, is_active = @is_active,
        updated_at = datetime('now')
       WHERE id = @id`
    ).run({
      ...v,
      id,
      user_id: ownerId,
      is_active: req.body.isActive === undefined ? existing.is_active : req.body.isActive ? 1 : 0,
    });

    if (parsed.imapPassword) {
      db.prepare('UPDATE mailboxes SET imap_password = ? WHERE id = ?').run(encrypt(parsed.imapPassword), id);
    }
    if (parsed.smtpPassword && req.body.smtpPassword) {
      db.prepare('UPDATE mailboxes SET smtp_password = ? WHERE id = ?').run(encrypt(parsed.smtpPassword), id);
    } else if (parsed.imapPassword && !req.body.smtpPassword) {
      db.prepare('UPDATE mailboxes SET smtp_password = ? WHERE id = ?').run(encrypt(parsed.imapPassword), id);
    }
  });

  tx();
  if (assignees) {
    mailboxStore.setUsers(id, assignees.ids, { makeDefault: Boolean(v.is_default) });
  }
  res.json({ mailbox: mailboxStore.getPublic(id) });
});

router.delete('/mailboxes/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM mailboxes WHERE id = ?').run(id);
  res.json({ ok: true });
});

/** Dry-run the credentials — either a saved mailbox or an unsaved form. */
router.post('/mailboxes/test', async (req, res) => {
  let mailbox;
  if (req.body.id) {
    mailbox = mailboxStore.getWithCredentials(Number(req.body.id));
    if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' });
  } else {
    const parsed = readMailboxBody(req.body, { requirePasswords: true });
    if (parsed.error) return bad(res, parsed.error);
    mailbox = {
      id: 0,
      ...parsed.values,
      imap_password_plain: parsed.imapPassword,
      smtp_password_plain: parsed.smtpPassword || parsed.imapPassword,
    };
  }

  const [imapResult, smtpResult] = await Promise.all([
    imap.testConnection(mailbox),
    smtp.testConnection(mailbox),
  ]);

  if (mailbox.id) {
    mailboxStore.recordCheck(
      mailbox.id,
      imapResult.ok && smtpResult.ok ? null : [imapResult.error, smtpResult.error].filter(Boolean).join(' | ')
    );
  }

  res.json({ imap: imapResult, smtp: smtpResult });
});

// ---------------------------------------------------------------------------
// Sent-mail audit trail
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// The database file: is it sound, and what is there to fall back on.
// ---------------------------------------------------------------------------
router.get('/database', (_req, res) => {
  let bytes = 0;
  try {
    bytes = fs.statSync(config.dbFile).size;
  } catch {
    /* reported as zero */
  }
  res.json({
    file: config.dbFile,
    bytes,
    lastCheck: maintenance.lastIntegrity(),
    backups: maintenance.list(),
    backupDir: maintenance.BACKUP_DIR,
  });
});

/** The full check, on demand — slower than the one taken at start-up. */
router.post('/database/check', (_req, res) => {
  res.json({ result: maintenance.integrity(db) });
});

router.post('/database/backup', (_req, res) => {
  try {
    res.status(201).json({ backup: maintenance.backup(db, { reason: 'requested by an administrator' }) });
  } catch (err) {
    res.status(500).json({ error: `Could not write a backup: ${err.message}` });
  }
});

// Downloading is the only way to get a copy off a host with no shell — which
// is the position this app is usually deployed into.
router.get('/database/backup/:name', (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  const known = maintenance.list().some((b) => b.name === name);
  if (!known) return res.status(404).json({ error: 'No such backup' });
  res.download(path.join(maintenance.BACKUP_DIR, name), name);
});

router.get('/sent-log', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = db
    .prepare(
      `SELECT l.*, u.name AS user_name FROM sent_log l JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC LIMIT ?`
    )
    .all(limit);
  res.json({ entries: rows });
});

module.exports = router;
