'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { db, bootstrap, applyAdminPasswordFromEnv, purgeExpiredSessions } = require('./db');
const authMw = require('./auth');
const imap = require('./mail/imap');
const { buildId } = require('./build');

const app = express();

if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// Express 5 leaves req.body undefined when a request carries no body — every
// route below reads it freely, so normalise it once here.
app.use((req, _res, next) => {
  if (!req.body) req.body = {};
  next();
});

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(authMw.attachUser);

// Signature profile pictures. Served to signed-in users only — these are
// staff photos, not public assets.
app.use(
  '/uploads',
  (req, res, next) => (req.user ? next() : res.status(401).end()),
  express.static(config.uploadDir, { dotfiles: 'deny', index: false, maxAge: '1h' })
);

// Deliberately says which build is live and whether the administrator
// bootstrap is configured — the two things that cannot otherwise be told
// apart from outside when a deploy misbehaves. Neither reveals a secret.
app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    brand: config.brand.name,
    build: buildId(),
    adminEmail: config.bootstrapAdminEmail,
    adminPasswordConfigured: Boolean(config.bootstrapAdminPassword),
    dataDir: config.dataDir,
  })
);

app.use('/api/auth', require('./routes/auth').router);
app.use('/api/admin', require('./routes/admin'));
app.use('/api/signature', require('./routes/signature').router);
app.use('/api/mail', require('./routes/mail'));

app.use(express.static(path.join(config.root, 'public'), { index: 'index.html', maxAge: '5m' }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is too large' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Unexpected server error' });
});

// Mint the encryption key now rather than on the first mailbox save, so it
// exists to be backed up from the moment the server comes up.
require('./crypto').ensureKey();

const credentials = bootstrap();
const adminApplied = credentials ? null : applyAdminPasswordFromEnv();
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

const server = app.listen(config.port, () => {
  console.log(`${config.brand.name} Mail running on ${config.appUrl || `http://localhost:${config.port}`}`);
  if (credentials) {
    console.log('\n──────────────────────────────────────────────');
    console.log(' First-run administrator account created');
    console.log(`   Email:    ${credentials.email}`);
    console.log(`   Password: ${credentials.password}`);
    if (credentials.generated) console.log('   (Change this password after your first sign-in.)');
    console.log('──────────────────────────────────────────────\n');
  }
  if (adminApplied) {
    console.log('\n──────────────────────────────────────────────');
    console.log(
      adminApplied.action === 'created'
        ? ' Administrator created from ADMIN_EMAIL / ADMIN_PASSWORD'
        : ' Administrator password reset from ADMIN_PASSWORD'
    );
    console.log(`   Email: ${adminApplied.email}`);
    console.log('   Sign in with the password set in your environment.');
    console.log('──────────────────────────────────────────────\n');
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  imap.closeAll();
  // Closing the database releases its write lock. A restart that skipped this
  // used to leave a lock behind and refuse to start again.
  try {
    db.close();
  } catch {
    /* already closed */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
