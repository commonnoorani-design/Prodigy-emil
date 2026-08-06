'use strict';

const express = require('express');
const multer = require('multer');

const config = require('../config');
const { db } = require('../db');
const auth = require('../auth');
const imap = require('../mail/imap');
const smtp = require('../mail/smtp');
const mailboxStore = require('../mail/mailboxes');
const { getSignature } = require('./signature');
const templates = require('../templates');

const router = express.Router();
router.use(auth.requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxAttachmentBytes, files: 10 },
});

/** Load a mailbox with credentials, but only if it belongs to the caller. */
function resolveMailbox(req, res) {
  const id = Number(req.query.mailboxId || req.body.mailboxId || 0);
  const owned = id
    ? mailboxStore.getForUser(id, req.user.id)
    : mailboxStore.listForUser(req.user.id)[0];
  if (!owned) {
    res.status(404).json({
      error: 'No business email is assigned to your account yet. Ask an administrator to assign one.',
    });
    return null;
  }
  return mailboxStore.getWithCredentials(owned.id);
}

function fail(res, err) {
  const message = err && err.message ? err.message : 'Mail server error';
  const auth401 = /auth|login|credential|password/i.test(message);
  res.status(auth401 ? 502 : 500).json({ error: message });
}

router.get('/folders', async (req, res) => {
  const mailbox = resolveMailbox(req, res);
  if (!mailbox) return;
  try {
    const folders = await imap.listFolders(mailbox);
    const statuses = await Promise.all(
      folders.slice(0, 12).map((f) =>
        imap.folderStatus(mailbox, f.path).catch(() => ({ path: f.path, total: 0, unseen: 0 }))
      )
    );
    const byPath = new Map(statuses.map((s) => [s.path, s]));
    mailboxStore.recordCheck(mailbox.id, null);
    res.json({
      folders: folders.map((f) => ({ ...f, ...(byPath.get(f.path) || { total: 0, unseen: 0 }) })),
    });
  } catch (err) {
    mailboxStore.recordCheck(mailbox.id, err.message);
    fail(res, err);
  }
});

router.get('/messages', async (req, res) => {
  const mailbox = resolveMailbox(req, res);
  if (!mailbox) return;
  try {
    const result = await imap.listMessages(mailbox, {
      path: req.query.path || 'INBOX',
      page: Number(req.query.page) || 1,
      pageSize: Math.min(Number(req.query.pageSize) || 25, 100),
      search: req.query.search || '',
    });
    mailboxStore.recordCheck(mailbox.id, null);
    res.json(result);
  } catch (err) {
    mailboxStore.recordCheck(mailbox.id, err.message);
    fail(res, err);
  }
});

router.get('/message', async (req, res) => {
  const mailbox = resolveMailbox(req, res);
  if (!mailbox) return;
  try {
    const message = await imap.getMessage(mailbox, {
      path: req.query.path || 'INBOX',
      uid: Number(req.query.uid),
      markSeen: req.query.markSeen !== '0',
    });
    res.json({ message });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/attachment', async (req, res) => {
  const mailbox = resolveMailbox(req, res);
  if (!mailbox) return;
  try {
    const att = await imap.getAttachment(mailbox, {
      path: req.query.path || 'INBOX',
      uid: Number(req.query.uid),
      index: Number(req.query.index) || 0,
    });
    res.setHeader('Content-Type', att.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${att.filename.replace(/["\\\r\n]/g, '')}"`
    );
    res.send(att.content);
  } catch (err) {
    fail(res, err);
  }
});

router.post('/flag', async (req, res) => {
  const mailbox = resolveMailbox(req, res);
  if (!mailbox) return;
  const allowed = { seen: '\\Seen', flagged: '\\Flagged', answered: '\\Answered' };
  const flag = allowed[req.body.flag];
  if (!flag) return res.status(400).json({ error: 'Unknown flag' });
  try {
    await imap.setFlag(mailbox, {
      path: req.body.path || 'INBOX',
      uid: Number(req.body.uid),
      flag,
      value: !!req.body.value,
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/move', async (req, res) => {
  const mailbox = resolveMailbox(req, res);
  if (!mailbox) return;
  try {
    await imap.moveMessage(mailbox, {
      path: req.body.path || 'INBOX',
      uid: Number(req.body.uid),
      target: String(req.body.target || ''),
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

router.delete('/message', async (req, res) => {
  const mailbox = resolveMailbox(req, res);
  if (!mailbox) return;
  try {
    await imap.deleteMessage(mailbox, {
      path: req.query.path || 'INBOX',
      uid: Number(req.query.uid),
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

function splitAddresses(value) {
  if (!value) return '';
  return String(value)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

function hasValidRecipient(value) {
  return String(value || '')
    .split(',')
    .some((a) => /[^@\s]+@[^@\s]+\.[^@\s]+/.test(a));
}

router.post('/send', upload.array('attachments', 10), async (req, res) => {
  const mailbox = resolveMailbox(req, res);
  if (!mailbox) return;

  const to = splitAddresses(req.body.to);
  const cc = splitAddresses(req.body.cc);
  const bcc = splitAddresses(req.body.bcc);
  if (!hasValidRecipient(to) && !hasValidRecipient(cc) && !hasValidRecipient(bcc)) {
    return res.status(400).json({ error: 'Add at least one valid recipient' });
  }

  const signature = getSignature(req.user.id);
  const references = req.body.references
    ? String(req.body.references).split(/\s+/).filter(Boolean)
    : [];

  try {
    const result = await smtp.sendMail({
      mailbox,
      signature,
      message: {
        to,
        cc,
        bcc,
        subject: String(req.body.subject || '').trim(),
        bodyHtml: req.body.bodyHtml || '',
        quotedHtml: req.body.quotedHtml || '',
        quotedText: req.body.quotedText || '',
        inReplyTo: req.body.inReplyTo || '',
        references,
        attachments: (req.files || []).map((f) => ({
          filename: f.originalname,
          content: f.buffer,
          contentType: f.mimetype,
        })),
      },
    });

    db.prepare(
      `INSERT INTO sent_log (user_id, mailbox_id, to_addr, cc_addr, bcc_addr, subject, message_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')`
    ).run(req.user.id, mailbox.id, to, cc, bcc, req.body.subject || '', result.messageId || '');

    // Mark the original as answered so the thread reads correctly everywhere.
    if (req.body.replyToUid && req.body.path) {
      imap
        .setFlag(mailbox, {
          path: req.body.path,
          uid: Number(req.body.replyToUid),
          flag: '\\Answered',
          value: true,
        })
        .catch(() => {});
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    db.prepare(
      `INSERT INTO sent_log (user_id, mailbox_id, to_addr, cc_addr, bcc_addr, subject, status, error)
       VALUES (?, ?, ?, ?, ?, ?, 'failed', ?)`
    ).run(req.user.id, mailbox.id, to, cc, bcc, req.body.subject || '', String(err.message).slice(0, 400));
    fail(res, err);
  }
});

/** Render the exact message that would be sent, without sending it. */
router.post('/preview', (req, res) => {
  const signature = getSignature(req.user.id);
  const { logoSrc, photoSrc } = smtp.previewSources(signature, req);
  res.json({
    html: templates.renderEmail({
      bodyHtml: smtp.sanitizeCompose(req.body.bodyHtml || ''),
      signature,
      logoSrc,
      photoSrc,
      quotedHtml: req.body.quotedHtml ? imap.cleanHtml(req.body.quotedHtml) : '',
    }),
  });
});

router.get('/sent-log', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM sent_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(req.user.id);
  res.json({ entries: rows });
});

module.exports = router;
