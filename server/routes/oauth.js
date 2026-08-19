'use strict';

/**
 * OAuth for the MCP endpoint.
 *
 * Some clients take nothing but a URL — Gemini Spark, for one — so there is
 * nowhere to paste a token. They discover this authorization server from the
 * 401 on /mcp, register themselves (RFC 7591), send the person here to sign in
 * and approve, and exchange the resulting code for a bearer token.
 *
 * That token is an ordinary api_token, so there is exactly one kind of
 * credential in the system: checked the same way, listed on the same screen,
 * and revoked by the same button.
 */

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const { db } = require('../db');
const auth = require('../auth');
const { randomToken, hashToken } = require('../crypto');
const templates = require('../templates');

const router = express.Router();
const esc = templates.escapeHtml;

const CODE_TTL_MS = 5 * 60 * 1000;

const authorizeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts. Please wait a few minutes.',
});

function issuer(req) {
  return config.originFor(req);
}

// ── Discovery ──────────────────────────────────────────────────────────────
/** RFC 9728: tells a client which authorization server guards /mcp. */
function protectedResource(req, res) {
  const base = issuer(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['mail'],
    bearer_methods_supported: ['header'],
    resource_documentation: `${base}/`,
  });
}

/** RFC 8414: where to register, authorize and get tokens. */
function authorizationServer(req, res) {
  const base = issuer(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: ['mail'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  });
}

// ── Dynamic client registration ────────────────────────────────────────────
router.post('/register', express.json(), (req, res) => {
  const body = req.body || {};
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];

  if (!redirectUris.length) {
    return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
  }
  for (const uri of redirectUris) {
    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `Not a URL: ${uri}` });
    }
    // Anything but https would let an approved token leave over a channel we
    // cannot vouch for. Loopback stays allowed so desktop clients still work.
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !loopback) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'Redirect URIs must use https, except on localhost',
      });
    }
  }

  const clientId = `pmc_${randomToken(16)}`;
  // A client that asks for no authentication method is public and relies on
  // PKCE alone; anything else gets a secret.
  const isPublic = body.token_endpoint_auth_method === 'none';
  const secret = isPublic ? null : randomToken(24);

  db.prepare(
    'INSERT INTO oauth_clients (client_id, secret_hash, name, redirect_uris) VALUES (?, ?, ?, ?)'
  ).run(clientId, secret ? hashToken(secret) : null, String(body.client_name || 'MCP client').slice(0, 80), JSON.stringify(redirectUris));

  const response = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: isPublic ? 'none' : 'client_secret_post',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    client_name: String(body.client_name || 'MCP client').slice(0, 80),
  };
  if (secret) {
    response.client_secret = secret;
    response.client_secret_expires_at = 0;
  }
  res.status(201).json(response);
});

// ── Authorization ──────────────────────────────────────────────────────────
function loadClient(clientId) {
  const row = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId);
  if (!row) return null;
  return { ...row, redirect_uris: JSON.parse(row.redirect_uris || '[]') };
}

function consentPage({ client, params, error, prefill = '' }) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}" />`)
    .join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect ${esc(client.name)}</title><link rel="stylesheet" href="/styles.css" /></head>
<body><section class="login"><div class="login-card">
<img src="/assets/logo-web.png" alt="Prodigy Educations" class="login-logo" />
<h1>Connect ${esc(client.name)}</h1>
<p class="login-sub">
  It will be able to read your mail and send messages as you. It cannot reach
  administration, and you can disconnect it at any time under
  <strong>Change password → AI access tokens</strong>.
</p>
<form method="post" action="/oauth/authorize">
  ${hidden}
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autocomplete="username" value="${esc(prefill)}" />
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required autocomplete="current-password" />
  ${error ? `<div class="form-error">${esc(error)}</div>` : ''}
  <button class="btn btn-primary btn-block" type="submit" name="decision" value="allow">Sign in and connect</button>
  <button class="btn btn-ghost btn-block" type="submit" name="decision" value="deny" style="margin-top:10px">Cancel</button>
</form>
</div></section></body></html>`;
}

/** Everything the authorize step needs to carry through the consent form. */
function readAuthParams(source) {
  return {
    client_id: String(source.client_id || ''),
    redirect_uri: String(source.redirect_uri || ''),
    state: String(source.state || ''),
    code_challenge: String(source.code_challenge || ''),
    code_challenge_method: String(source.code_challenge_method || ''),
    scope: String(source.scope || ''),
    resource: String(source.resource || ''),
  };
}

function validate(params) {
  const client = loadClient(params.client_id);
  if (!client) return { error: 'Unknown client. Ask the app to register again.' };
  if (!params.redirect_uri || !client.redirect_uris.includes(params.redirect_uri)) {
    return { error: 'That redirect address is not registered for this client.' };
  }
  if (!params.code_challenge || params.code_challenge_method !== 'S256') {
    return { error: 'This server requires PKCE with S256.' };
  }
  return { client };
}

router.get('/authorize', authorizeLimiter, (req, res) => {
  const params = readAuthParams(req.query);
  const { client, error } = validate(params);
  // A bad client or redirect must never be redirected to — say so here instead.
  if (error) return res.status(400).type('html').send(consentPage({
    client: { name: 'this app' }, params, error,
  }));
  res.type('html').send(consentPage({ client, params, prefill: req.user ? req.user.login_email : '' }));
});

router.post('/authorize', authorizeLimiter, express.urlencoded({ extended: false }), (req, res) => {
  const params = readAuthParams(req.body);
  const { client, error } = validate(params);
  if (error) return res.status(400).type('html').send(consentPage({ client: { name: 'this app' }, params, error }));

  const redirect = new URL(params.redirect_uri);
  if (params.state) redirect.searchParams.set('state', params.state);

  if (req.body.decision !== 'allow') {
    redirect.searchParams.set('error', 'access_denied');
    return res.redirect(redirect.toString());
  }

  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE login_email = ?').get(email);
  if (!user || !user.is_active || !auth.verifyPassword(password, user.password_hash)) {
    return res.status(401).type('html').send(
      consentPage({ client, params, error: 'Incorrect email or password', prefill: email })
    );
  }

  const code = randomToken(32);
  db.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    hashToken(code),
    client.client_id,
    user.id,
    params.redirect_uri,
    params.code_challenge,
    new Date(Date.now() + CODE_TTL_MS).toISOString().replace('T', ' ').slice(0, 19)
  );

  redirect.searchParams.set('code', code);
  res.redirect(redirect.toString());
});

// ── Token ──────────────────────────────────────────────────────────────────
function clientCredentials(req) {
  const header = req.get('authorization') || '';
  const basic = header.match(/^Basic\s+(\S+)$/i);
  if (basic) {
    const [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
    return { id, secret };
  }
  return { id: req.body.client_id, secret: req.body.client_secret };
}

router.post('/token', express.urlencoded({ extended: false }), (req, res) => {
  const fail = (code, description, status = 400) =>
    res.status(status).json({ error: code, error_description: description });

  if (req.body.grant_type !== 'authorization_code') {
    return fail('unsupported_grant_type', 'Only authorization_code is supported');
  }

  const { id, secret } = clientCredentials(req);
  const client = loadClient(id);
  if (!client) return fail('invalid_client', 'Unknown client', 401);
  if (client.secret_hash && (!secret || hashToken(secret) !== client.secret_hash)) {
    return fail('invalid_client', 'Bad client secret', 401);
  }

  const code = String(req.body.code || '');
  const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hashToken(code));
  // Single use: gone the moment it is looked up, whether or not it checks out.
  if (row) db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(row.code_hash);

  if (!row) return fail('invalid_grant', 'That code is not valid');
  if (row.client_id !== client.client_id) return fail('invalid_grant', 'That code belongs to another client');
  if (new Date(`${row.expires_at}Z`).getTime() < Date.now()) return fail('invalid_grant', 'That code has expired');
  if (String(req.body.redirect_uri || '') !== row.redirect_uri) {
    return fail('invalid_grant', 'redirect_uri does not match the one used to authorize');
  }

  const verifier = String(req.body.code_verifier || '');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  if (!verifier || challenge !== row.code_challenge) return fail('invalid_grant', 'PKCE verification failed');

  const { token } = auth.createApiToken(row.user_id, `${client.name} (connected)`);
  res.set('Cache-Control', 'no-store');
  res.json({ access_token: token, token_type: 'Bearer', scope: 'mail' });
});

module.exports = { router, protectedResource, authorizationServer };
