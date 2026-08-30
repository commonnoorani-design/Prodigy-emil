'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { db, damaged, bootstrap, applyAdminPasswordFromEnv, purgeExpiredSessions, maintenance } = require('./db');
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

app.use(
  damaged
    ? (req, _res, next) => {
        req.user = null;
        next();
      }
    : authMw.attachUser
);

// Signature profile pictures. Served to signed-in users only — these are
// staff photos, not public assets.
app.use(
  '/uploads',
  (req, res, next) => (req.user ? next() : res.status(401).end()),
  express.static(config.uploadDir, { dotfiles: 'deny', index: false, maxAge: '1h' })
);

// Nothing that answers on /api may be cached: a proxy or browser replaying a
// stale 401 would sign a person out the moment they signed in, and a replayed
// 200 would show them somebody else's mail. The same goes for the MCP and
// OAuth endpoints, which carry per-token answers.
app.use(['/api', '/mcp', '/oauth', '/.well-known'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// The MCP endpoint and its discovery documents are meant to be called by other
// people's software, including clients that run in a browser — Gemini Spark
// among them. Without these headers such a client never gets a reply it is
// allowed to read, and reports the server as unreachable.
//
// Safe as a wildcard precisely because /mcp refuses cookie sessions: it only
// accepts a bearer token, and `Allow-Origin: *` forbids credentialed requests
// anyway, so no browser can be tricked into spending its own session here.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};
app.use(
  ['/mcp', '/oauth/register', '/oauth/token', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server'],
  (req, res, next) => {
    res.set(CORS);
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  }
);

// Deliberately says which build is live and whether the administrator
// bootstrap is configured — the two things that cannot otherwise be told
// apart from outside when a deploy misbehaves. The instance id and uptime are
// there to answer the next question: whether the app is quietly restarting,
// or whether more than one copy of it is answering behind the CDN.
const INSTANCE = require('crypto').randomBytes(4).toString('hex');
const STARTED_AT = Date.now();

app.get('/api/health', async (req, res) => {
  const health = {
    ok: true,
    brand: config.brand.name,
    build: buildId(),
    instance: INSTANCE,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    sessions: damaged
      ? null
      : db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > datetime('now')").get().n,
    adminEmail: config.bootstrapAdminEmail,
    adminPasswordConfigured: Boolean(config.bootstrapAdminPassword),
    needsSetup: damaged ? false : require('./routes/setup').needsSetup(),
    dataDir: config.dataDir,
    dbFile: config.dbFile,
    // Whether the file underneath all of this is sound, and how many copies of
    // it there are to fall back on. Checked at start-up, not per request.
    dbHealthy: (maintenance.lastIntegrity() || {}).ok !== false,
    dbCheckedAt: (maintenance.lastIntegrity() || {}).at || null,
    backups: maintenance.list().length,
    // While the database is damaged nobody can sign in to look at the
    // administration screen, so the detail needed to act has to be here.
    // SQLite's complaints name pages and indexes; they give nothing away.
    ...(damaged
      ? {
          dbCheck: (maintenance.lastIntegrity() || {}).messages || [],
          backupList: maintenance.list().map((b) => b.name),
        }
      : {}),
    // A repair that worked is worth reporting too — it says what it did and
    // what, if anything, did not come back.
    ...(maintenance.lastRepair() ? { dbRepair: maintenance.lastRepair() } : {}),
  };
  // ?selftest=1 asks the app to call its own API the way the MCP tools do.
  // When an assistant reports every tool failing, this says whether the app
  // can reach itself at all, and on which address.
  if (req.query.selftest) health.selfTest = await mcp.selfTest(req);
  res.json(health);
});

// A damaged database is not something to work around request by request:
// every route below reads or writes it, and writing to it makes the damage
// worse. Answer with what happened and what fixes it — /api/health above is
// left reachable, because that is where the detail is.
if (damaged) {
  app.use(['/api', '/mcp'], (_req, res) =>
    res.status(503).json({
      error:
        'The database file is damaged, so the app has stopped using it. Nothing has been lost: ' +
        'restore the most recent backup by setting RESTORE_BACKUP=latest in the hosting panel and ' +
        'restarting. See /api/health for the details.',
    })
  );
}

// MCP authorization discovery. A client that gets a 401 from /mcp reads these
// to find out how to ask for access — which is the only route in for a client
// that takes a URL and nothing else.
const oauth = require('./routes/oauth');
app.get('/.well-known/oauth-protected-resource', oauth.protectedResource);
app.get('/.well-known/oauth-protected-resource/mcp', oauth.protectedResource);
app.get('/.well-known/oauth-authorization-server', oauth.authorizationServer);
app.get('/.well-known/oauth-authorization-server/mcp', oauth.authorizationServer);
app.use('/oauth', oauth.router);
const mcp = require('./routes/mcp');
app.use('/mcp', mcp);
app.use('/api/setup', require('./routes/setup').router);
app.use('/api/auth', require('./routes/auth').router);
app.use('/api/admin', require('./routes/admin'));
app.use('/api/signature', require('./routes/signature').router);
app.use('/api/mail', require('./routes/mail'));

// The page is served through a CDN we do not control, and a cached copy of
// app.js outliving a deploy means the browser runs last week's code against
// this week's server. Stamp the build id onto every asset URL so each deploy
// asks for a URL the cache has never seen, and let the small HTML shell that
// carries those URLs revalidate every time.
const INDEX_FILE = path.join(config.root, 'public', 'index.html');
let indexHtml = null;

function renderIndex() {
  if (!indexHtml) {
    const version = buildId();
    indexHtml = fs
      .readFileSync(INDEX_FILE, 'utf8')
      .replace(
        /(href|src)="\/([^"?:]+\.(?:js|css)|assets\/[^"?]+)"/g,
        (_match, attr, file) => `${attr}="/${file}?v=${version}"`
      );
  }
  return indexHtml;
}

function sendIndex(_req, res) {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.type('html').send(renderIndex());
}

app.get('/', sendIndex);
app.use(express.static(path.join(config.root, 'public'), { index: false, maxAge: '1h' }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.get(/.*/, sendIndex);

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

// Prove the database before writing anything to it, and take a copy while it
// is known good.
maintenance.onStart(db);
setInterval(() => {
  try {
    maintenance.backupIfDue(db);
  } catch (err) {
    console.error(`[db] scheduled backup failed: ${err.message}`);
  }
}, 6 * 3600 * 1000).unref();

const credentials = damaged ? null : bootstrap();
const adminApplied = credentials || damaged ? null : applyAdminPasswordFromEnv();
if (!damaged) {
  purgeExpiredSessions();
  setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();
}

const server = app.listen(config.port, () => {
  require('./self').set(server.address());
  console.log(`${config.brand.name} Mail running on ${config.appUrl || `http://localhost:${config.port}`}`);
  if (credentials) {
    console.log('\n──────────────────────────────────────────────');
    console.log(' First-run administrator account created');
    console.log(`   Email:    ${credentials.email}`);
    console.log(`   Password: ${credentials.password}`);
    console.log('──────────────────────────────────────────────\n');
  }
  if (damaged) {
    console.error(` The site is up but refusing to use the database. ${config.appUrl || ''}/api/health says why.`);
  }
  if (!damaged && require('./routes/setup').needsSetup()) {
    console.log('\n──────────────────────────────────────────────');
    console.log(' No administrator yet — open the site to create one.');
    console.log(' Do it now: until you do, the first visitor can claim it.');
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
  mcp.closeAll();
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
