'use strict';

/**
 * Remote MCP endpoint, so an assistant can connect by URL instead of running
 * anything locally — which is what Gemini CLI and similar clients want:
 *
 *   "httpUrl": "https://email.prodigyeducations.com/mcp",
 *   "headers": { "Authorization": "Bearer pem_…" }
 *
 * Each request gets a fresh server and transport. MCP's stateless mode suits
 * this app: there is nothing to keep between calls, and it survives the
 * process being restarted or run behind a proxy that spreads requests around.
 */

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');

const config = require('../config');
const self = require('../self');
const { registerTools } = require('../../mcp/tools.cjs');

const router = express.Router();

/** JSON-RPC shaped error, which is what an MCP client knows how to read. */
function rpcError(res, status, message) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: status === 401 ? -32001 : -32000, message },
    id: null,
  });
}

/**
 * Every address this app might answer to from inside itself.
 *
 * Loopback is the obvious one and normally the only one needed, but a host can
 * put the app somewhere that will not talk to itself over 127.0.0.1 — and a
 * tool that cannot reach the API fails with nothing but "fetch failed", which
 * a client reports as the whole server being unreachable. So try the sensible
 * loopback names first and fall back to the app's own public address, which is
 * slower but is known to work because that is how the request arrived.
 */
function internalBases(req) {
  const port = self.port() || config.port;
  const bases = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
  const external = (config.appUrl || config.originFor(req) || '').replace(/\/+$/, '');
  if (/^https?:\/\//.test(external) && !bases.includes(external)) bases.push(external);
  return bases;
}

// The first address that answered. Kept so the fallbacks are paid for once.
let preferredBase = null;

function orderedBases(req) {
  const bases = internalBases(req);
  if (!preferredBase) return bases;
  return [preferredBase, ...bases.filter((b) => b !== preferredBase)];
}

/**
 * Tools reach the rest of the app through its own HTTP API, exactly as the
 * local stdio server does. One code path means an assistant's mail is built,
 * signed and footered by the same routes a person's is.
 */
function callerFor(req) {
  const authorization = req.get('authorization') || '';
  return async function call(path, { method = 'GET', body, form } = {}) {
    const headers = { Authorization: authorization };
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const bases = orderedBases(req);
    let unreachable = null;
    for (const base of bases) {
      let res;
      try {
        res = await fetch(base + path, { method, headers, body: payload });
      } catch (err) {
        unreachable = err; // this address does not answer — try the next one
        continue;
      }
      preferredBase = base;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    }
    throw new Error(
      `The mail API did not answer on any of its own addresses (${reason(unreachable)}): ${bases.join(', ')}`
    );
  };
}

/** undici hides the useful part — ECONNREFUSED and friends — a level or two down. */
function reason(err) {
  const cause = err && err.cause;
  const nested = cause && Array.isArray(cause.errors) ? cause.errors[0] : null;
  return (cause && cause.code) || (nested && nested.code) || (cause && cause.message) || (err && err.message) || 'unknown';
}

/** Which of those addresses actually answer — reported by /api/health?selftest=1. */
async function selfTest(req) {
  const results = [];
  for (const base of internalBases(req)) {
    const started = Date.now();
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) });
      results.push({ base, ok: res.ok, status: res.status, ms: Date.now() - started });
    } catch (err) {
      results.push({ base, ok: false, error: reason(err) });
    }
  }
  return results;
}

/** Common gate: this endpoint is for tokens, never for a browser session. */
function denyUnauthenticated(req, res) {
  if (!req.user) {
    // RFC 9728: point at the metadata so a client that has no token can start
    // the OAuth flow by itself rather than simply failing.
    const base = config.originFor(req);
    res.set(
      'WWW-Authenticate',
      `Bearer realm="Prodigy Educations Mail", resource_metadata="${base}/.well-known/oauth-protected-resource"`
    );
    rpcError(
      res,
      401,
      'Authorization required. Either connect with OAuth, or send a personal access token as ' +
        '"Authorization: Bearer pem_…" (created in the app under Change password → AI access tokens).'
    );
    return true;
  }
  if (!req.viaApiToken) {
    rpcError(res, 401, 'This endpoint needs an API token, not a browser session.');
    return true;
  }
  return false;
}

function newServer(req) {
  const server = new McpServer({ name: 'prodigy-mail', version: '1.0.0' });
  registerTools(server, callerFor(req));
  return server;
}

router.post('/', express.json({ limit: '4mb' }), async (req, res) => {
  if (denyUnauthenticated(req, res)) return;

  const server = newServer(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) rpcError(res, 500, err.message);
  }
});

// ---------------------------------------------------------------------------
// The older HTTP+SSE transport, on the same URL.
//
// Plenty of hosted clients still open a connection the 2024-11-05 way: GET the
// address, keep the stream open, and post replies back to whatever endpoint the
// first event names. Answering those with 405 is what a client reports as
// "the server connection is closed and unreachable" — so answer them properly.
// A current client asking for the optional notification stream sends
// MCP-Protocol-Version and is told there is nothing to stream, as before.
// ---------------------------------------------------------------------------
const legacy = new Map(); // sessionId -> { transport, server, ping }
const MAX_LEGACY_STREAMS = 20;
const PING_MS = 25_000;

const notAllowed = (_req, res) =>
  rpcError(res, 405, 'This MCP endpoint is stateless — use POST.');

function wantsEventStream(req) {
  return (req.get('accept') || '').includes('text/event-stream');
}

function dropLegacy(sessionId) {
  const entry = legacy.get(sessionId);
  if (!entry) return;
  legacy.delete(sessionId);
  clearInterval(entry.ping);
  entry.transport.close().catch(() => {});
  entry.server.close().catch(() => {});
}

router.get('/', async (req, res) => {
  if (!wantsEventStream(req) || req.get('mcp-protocol-version')) return notAllowed(req, res);
  if (denyUnauthenticated(req, res)) return;
  if (legacy.size >= MAX_LEGACY_STREAMS) {
    return rpcError(res, 503, 'Too many open connections. Try again in a minute.');
  }

  const transport = new SSEServerTransport('/mcp/messages', res);
  const server = newServer(req);
  // Idle streams are cut by proxies long before a person next asks for mail.
  // A comment line every 25 seconds is invisible to the client and keeps the
  // connection counted as alive.
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      dropLegacy(transport.sessionId);
    }
  }, PING_MS);
  ping.unref();

  legacy.set(transport.sessionId, { transport, server, ping });
  res.on('close', () => dropLegacy(transport.sessionId));

  try {
    await server.connect(transport);
  } catch (err) {
    dropLegacy(transport.sessionId);
    if (!res.headersSent) rpcError(res, 500, err.message);
  }
});

router.post('/messages', express.json({ limit: '4mb' }), async (req, res) => {
  if (denyUnauthenticated(req, res)) return;
  const entry = legacy.get(String(req.query.sessionId || ''));
  if (!entry) return rpcError(res, 404, 'That connection has ended — reconnect and try again.');
  await entry.transport.handlePostMessage(req, res, req.body);
});

router.delete('/', notAllowed);

/** Close every open stream, so the process can exit promptly. */
function closeAll() {
  for (const sessionId of [...legacy.keys()]) dropLegacy(sessionId);
}

router.closeAll = closeAll;
router.selfTest = selfTest;

module.exports = router;
