'use strict';

require('dotenv').config();

const path = require('path');

const root = path.resolve(__dirname, '..');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const config = {
  root,
  port: Number(process.env.PORT || 3000),
  // Public base URL of this app. Used to build absolute links for logos /
  // profile pictures when previewing a message in the browser.
  appUrl: (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'data', 'uploads'),
  dbFile: process.env.DB_FILE || path.join(root, 'data', 'prodigy-mail.db'),

  // 32-byte key (hex or base64 or plain text) used to encrypt stored mailbox
  // passwords. MUST be set in production.
  secretKey: process.env.SECRET_KEY || '',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
  secureCookies: bool(process.env.SECURE_COOKIES, process.env.NODE_ENV === 'production'),
  trustProxy: bool(process.env.TRUST_PROXY, false),

  // First-run administrator. Created automatically when the users table is empty.
  bootstrapAdminEmail: process.env.ADMIN_EMAIL || 'admin@prodigyeducations.com',
  bootstrapAdminPassword: process.env.ADMIN_PASSWORD || '',
  bootstrapAdminName: process.env.ADMIN_NAME || 'Prodigy Administrator',

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

module.exports = config;
