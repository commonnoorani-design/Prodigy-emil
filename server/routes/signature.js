'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const { db } = require('../db');
const auth = require('../auth');
const templates = require('../templates');
const smtp = require('../mail/smtp');

const router = express.Router();
router.use(auth.requireAuth);

const ALLOWED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

const PHONE_TYPES = new Set(['call_sms_whatsapp', 'call_sms', 'whatsapp']);

function getSignature(userId) {
  let row = db.prepare('SELECT * FROM signatures WHERE user_id = ?').get(userId);
  if (!row) {
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    db.prepare('INSERT INTO signatures (user_id, full_name) VALUES (?, ?)').run(userId, user ? user.name : '');
    row = db.prepare('SELECT * FROM signatures WHERE user_id = ?').get(userId);
  }
  return row;
}

/**
 * Which signature is a request allowed to touch? Users may only edit their
 * own; administrators may edit anyone's.
 */
function targetUserId(req) {
  const requested = req.query.userId || (req.body || {}).userId;
  if (!requested) return req.user.id;
  const id = Number(requested);
  if (id === req.user.id) return id;
  if (req.user.role !== 'admin') return null;
  return db.prepare('SELECT id FROM users WHERE id = ?').get(id) ? id : null;
}

router.get('/', (req, res) => {
  const userId = targetUserId(req);
  if (!userId) return res.status(403).json({ error: 'Not allowed' });
  res.json({ signature: getSignature(userId) });
});

router.put('/', (req, res) => {
  const userId = targetUserId(req);
  if (!userId) return res.status(403).json({ error: 'Not allowed' });

  const body = req.body || {};
  const fullName = String(body.fullName ?? '').trim();
  if (!fullName) return res.status(400).json({ error: 'Name is required in the signature' });

  const phoneType = PHONE_TYPES.has(body.phoneType) ? body.phoneType : 'call_sms_whatsapp';
  const meeting = String(body.meetingLink ?? '').trim();
  if (meeting && !/^(https?:\/\/|[\w.-]+\.[a-z]{2,})/i.test(meeting)) {
    return res.status(400).json({ error: 'Meeting link must be a valid URL' });
  }

  getSignature(userId);
  db.prepare(
    `UPDATE signatures SET full_name = ?, designation = ?, email = ?, phone = ?, phone_type = ?,
       meeting_link = ?, updated_at = datetime('now')
     WHERE user_id = ?`
  ).run(
    fullName,
    String(body.designation ?? '').trim(),
    String(body.email ?? '').trim(),
    String(body.phone ?? '').trim(),
    phoneType,
    meeting,
    userId
  );

  res.json({ signature: getSignature(userId) });
});

router.post('/photo', upload.single('photo'), (req, res) => {
  const userId = targetUserId(req);
  if (!userId) return res.status(403).json({ error: 'Not allowed' });
  if (!req.file) return res.status(400).json({ error: 'Choose an image to upload' });
  if (!ALLOWED_IMAGE.has(req.file.mimetype)) {
    return res.status(400).json({ error: 'Profile picture must be a JPG, PNG, WEBP or GIF' });
  }

  const current = getSignature(userId);
  const filename = `dp-${userId}-${crypto.randomBytes(6).toString('hex')}${EXT_BY_TYPE[req.file.mimetype]}`;
  fs.writeFileSync(path.join(config.uploadDir, filename), req.file.buffer, { mode: 0o600 });

  if (current.photo_file) {
    const old = path.join(config.uploadDir, path.basename(current.photo_file));
    fs.rm(old, { force: true }, () => {});
  }

  db.prepare("UPDATE signatures SET photo_file = ?, updated_at = datetime('now') WHERE user_id = ?").run(
    filename,
    userId
  );
  res.json({ signature: getSignature(userId) });
});

router.delete('/photo', (req, res) => {
  const userId = targetUserId(req);
  if (!userId) return res.status(403).json({ error: 'Not allowed' });
  const current = getSignature(userId);
  if (current.photo_file) {
    fs.rm(path.join(config.uploadDir, path.basename(current.photo_file)), { force: true }, () => {});
  }
  db.prepare("UPDATE signatures SET photo_file = '', updated_at = datetime('now') WHERE user_id = ?").run(userId);
  res.json({ signature: getSignature(userId) });
});

/** Rendered signature card on its own — used by the live editor preview. */
router.get('/preview', (req, res) => {
  const userId = targetUserId(req);
  if (!userId) return res.status(403).json({ error: 'Not allowed' });
  const signature = getSignature(userId);
  const { photoSrc } = smtp.previewSources(signature, req);
  res.json({ html: templates.buildSignature(signature, { photoSrc }) });
});

/** Full message shell (header + body + signature + footer) for preview. */
router.get('/preview-email', (req, res) => {
  const userId = targetUserId(req);
  if (!userId) return res.status(403).json({ error: 'Not allowed' });
  const signature = getSignature(userId);
  const { logoSrc, photoSrc } = smtp.previewSources(signature, req);
  const sample =
    '<p>Dear Student,</p><p>Thank you for reaching out to Prodigy Educations. This is how your branded message will look to the person receiving it.</p><p>Warm regards,</p>';
  res.json({
    html: templates.renderEmail({
      bodyHtml: req.query.body ? smtp.sanitizeCompose(String(req.query.body)) : sample,
      signature,
      logoSrc,
      photoSrc,
    }),
  });
});

module.exports = { router, getSignature };
