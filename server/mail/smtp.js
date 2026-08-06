'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const sanitizeHtml = require('sanitize-html');

const config = require('../config');
const templates = require('../templates');
const imap = require('./imap');

// A trimmed, downscaled copy of the brand mark — it rides along with every
// outgoing message, so keep it small. Falls back to the full-size original.
const LOGO_CANDIDATES = [
  path.join(config.root, 'public', 'assets', 'logo-email.png'),
  path.join(config.root, 'public', 'assets', 'logo.png'),
];
const LOGO_PATH = LOGO_CANDIDATES.find((p) => fs.existsSync(p)) || '';

function transportFor(mailbox) {
  return nodemailer.createTransport({
    host: mailbox.smtp_host,
    port: Number(mailbox.smtp_port) || 465,
    secure: !!mailbox.smtp_secure,
    auth: { user: mailbox.smtp_user, pass: mailbox.smtp_password_plain },
    tls: { rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== '1' },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  });
}

async function testConnection(mailbox) {
  const transport = transportFor(mailbox);
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    transport.close();
  }
}

// The composer is a contenteditable field, so treat its output as untrusted.
const COMPOSE_SANITIZE = {
  allowedTags: [
    'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'a',
    'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'pre', 'code', 'hr',
    'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img',
  ],
  allowedAttributes: {
    '*': ['style', 'align'],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    td: ['colspan', 'rowspan', 'width'],
    th: ['colspan', 'rowspan', 'width'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowedStyles: {
    '*': {
      color: [/.*/], 'background-color': [/.*/], 'text-align': [/.*/],
      'font-size': [/.*/], 'font-weight': [/.*/], 'font-style': [/.*/],
      'text-decoration': [/.*/], 'padding-left': [/.*/], 'margin-left': [/.*/],
    },
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
};

function sanitizeCompose(html) {
  return sanitizeHtml(html || '', COMPOSE_SANITIZE);
}

function htmlToText(html) {
  return sanitizeHtml(html || '', { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function photoPathFor(signature) {
  if (!signature || !signature.photo_file) return null;
  const file = path.join(config.uploadDir, path.basename(signature.photo_file));
  return fs.existsSync(file) ? file : null;
}

/**
 * Absolute URLs for in-browser preview (no CIDs available there).
 * Pass the request so the origin is right even when APP_URL is unset.
 */
function previewSources(signature, req) {
  const origin = config.originFor(req);
  return {
    logoSrc: `${origin}/assets/logo-email.png`,
    photoSrc: signature && signature.photo_file
      ? `${origin}/uploads/${encodeURIComponent(path.basename(signature.photo_file))}`
      : '',
  };
}

function formatAddress(name, address) {
  return name ? `"${String(name).replace(/"/g, "'")}" <${address}>` : address;
}

/**
 * Compose and deliver a branded message, then file a copy in Sent.
 *
 * @param {object} args
 * @param {object} args.mailbox   Mailbox record with decrypted credentials.
 * @param {object} args.signature Signature record for the sending user (or null).
 * @param {object} args.message   { to, cc, bcc, subject, bodyHtml, inReplyTo, references, quotedHtml, quotedText, attachments }
 */
async function sendMail({ mailbox, signature, message }) {
  const bodyHtml = sanitizeCompose(message.bodyHtml);
  const bodyText = message.bodyText || htmlToText(bodyHtml);

  const embedded = [];
  let logoSrc = '';
  if (LOGO_PATH) {
    embedded.push({ filename: 'prodigy-educations.png', path: LOGO_PATH, cid: templates.LOGO_CID });
    logoSrc = `cid:${templates.LOGO_CID}`;
  }

  let photoSrc = '';
  const photo = photoPathFor(signature);
  if (photo) {
    embedded.push({ filename: path.basename(photo), path: photo, cid: templates.PHOTO_CID });
    photoSrc = `cid:${templates.PHOTO_CID}`;
  }

  const html = templates.renderEmail({
    bodyHtml,
    signature,
    logoSrc,
    photoSrc,
    quotedHtml: message.quotedHtml ? imap.cleanHtml(message.quotedHtml) : '',
  });

  const text = templates.renderEmailText({
    bodyText,
    signature,
    quotedText: message.quotedText || '',
  });

  const attachments = embedded.concat(
    (message.attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    }))
  );

  const mailOptions = {
    from: formatAddress(mailbox.display_name || (signature && signature.full_name) || '', mailbox.address),
    to: message.to,
    cc: message.cc || undefined,
    bcc: message.bcc || undefined,
    replyTo: message.replyTo || undefined,
    subject: message.subject || '(no subject)',
    html,
    text,
    attachments,
    headers: {
      'X-Mailer': 'Prodigy Educations Mail',
    },
  };

  if (message.inReplyTo) {
    mailOptions.inReplyTo = message.inReplyTo;
    mailOptions.references = []
      .concat(message.references || [])
      .concat(message.inReplyTo)
      .filter(Boolean);
  }

  // Build the MIME message once, then transmit that exact bytes-on-the-wire
  // copy — so the message filed in Sent matches what the recipient receives,
  // Message-ID and all.
  const built = await buildRaw(mailOptions);

  const transport = transportFor(mailbox);
  let info;
  try {
    info = await transport.sendMail({ envelope: built.envelope, raw: built.raw });
  } finally {
    transport.close();
  }

  // File a copy in Sent so the thread stays complete in every mail client.
  let saved = { ok: false };
  try {
    saved = await imap.appendToSent(mailbox, built.raw, mailbox.sent_folder || '');
  } catch (err) {
    saved = { ok: false, reason: err.message };
  }

  return {
    messageId: built.messageId,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
    saved,
  };
}

async function buildRaw(mailOptions) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  try {
    const info = await transport.sendMail(mailOptions);
    return { raw: info.message, envelope: info.envelope, messageId: info.messageId };
  } finally {
    transport.close();
  }
}

module.exports = { sendMail, testConnection, sanitizeCompose, htmlToText, previewSources };
