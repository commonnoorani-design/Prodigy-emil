'use strict';

require('dotenv').config();

const path = require('path');

const root = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Values typed into a hosting control panel routinely arrive with stray
 * whitespace, or wrapped in the quotes someone copied along with them. Taken
 * literally they produce a password nobody can type, so clean them up.
 */
function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  let out = String(value).trim();
  if (out.length >= 2 && /^(".*"|'.*')$/s.test(out)) out = out.slice(1, -1).trim();
  return out || fallback;
}

const config = {
  root,
  port: Number(process.env.PORT || 3000),
  // Public base URL of this app, used to build absolute links for logos and
  // profile pictures when previewing a message in the browser. Leave it unset
  // and each request's own origin is used instead.
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  dataDir,
  // Both live inside DATA_DIR unless they are pointed somewhere else, so that
  // moving the data onto permanent storage is one setting rather than three.
  // Getting that wrong on a host that replaces the application folder on every
  // deploy costs the database — and with it every session, which reads from
  // the browser as being signed out the moment you sign in.
  uploadDir: process.env.UPLOAD_DIR || path.join(dataDir, 'uploads'),
  dbFile: process.env.DB_FILE || path.join(dataDir, 'prodigy-mail.db'),

  // 32-byte key (hex or base64 or plain text) used to encrypt stored mailbox
  // passwords. MUST be set in production.
  secretKey: process.env.SECRET_KEY || '',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
  secureCookies: bool(process.env.SECURE_COOKIES, process.env.NODE_ENV === 'production'),
  trustProxy: bool(process.env.TRUST_PROXY, false),

  // First-run administrator. Created automatically when the users table is empty.
  bootstrapAdminEmail: text(process.env.ADMIN_EMAIL, 'admin@prodigyeducations.com').toLowerCase(),
  bootstrapAdminPassword: text(process.env.ADMIN_PASSWORD),
  bootstrapAdminName: text(process.env.ADMIN_NAME, 'Prodigy Administrator'),

  // Branding — shared by every outgoing message.
  brand: {
    name: process.env.BRAND_NAME || 'Prodigy Educations',
    tagline: process.env.BRAND_TAGLINE || 'Learning without limits',
    website: process.env.BRAND_WEBSITE || 'https://prodigyeducations.com',
    websiteLabel: process.env.BRAND_WEBSITE_LABEL || 'prodigyeducations.com',
    supportEmail: process.env.BRAND_SUPPORT_EMAIL || 'support@prodigyeducations.com',
    whatsapp: process.env.BRAND_WHATSAPP || '+92 330 9829829',
    established: process.env.BRAND_ESTABLISHED || '2020',
    address: process.env.BRAND_ADDRESS || '',
    navy: process.env.BRAND_NAVY || '#1e3a63',
    gold: process.env.BRAND_GOLD || '#b7a06a',
    ink: process.env.BRAND_INK || '#12161c',
  },

  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 8 * 1024 * 1024),
  maxAttachmentBytes: Number(process.env.MAX_ATTACHMENT_BYTES || 20 * 1024 * 1024),
};

config.brand.whatsappDigits = config.brand.whatsapp.replace(/[^\d]/g, '');

/** Where this app is reachable, as seen by the request being served. */
config.originFor = (req) => {
  if (config.appUrl) return config.appUrl;
  if (!req) return `http://localhost:${config.port}`;
  const proto = (config.trustProxy && req.get('x-forwarded-proto')) || req.protocol || 'http';
  const host = req.get('host');
  return host ? `${proto.split(',')[0].trim()}://${host}` : `http://localhost:${config.port}`;
};

module.exports = config;
