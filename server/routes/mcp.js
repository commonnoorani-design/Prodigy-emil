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

const config = require('../config');
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
 * Tools reach the rest of the app through its own HTTP API, exactly as the
 * local stdio server does. One code path means an assistant's mail is built,
 * signed and footered by the same routes a person's is.
 */
function callerFor(authorization) {
  const base = `http://127.0.0.1:${config.port}`;
  return async function call(path, { method = 'GET', body, form } = {}) {
    const headers = { Authorization: authorization };
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers, body: payload });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };
}

router.post('/', express.json({ limit: '4mb' }), async (req, res) => {
  const authorization = req.get('authorization') || '';
  if (!req.user) {
    res.set('WWW-Authenticate', 'Bearer realm="Prodigy Educations Mail"');
    return rpcError(
      res,
      401,
      'Send an access token as "Authorization: Bearer pem_…". Create one in the app under Change password → AI access tokens.'
    );
  }
  if (!req.viaApiToken) {
    return rpcError(res, 401, 'This endpoint needs an API token, not a browser session.');
  }

  const server = new McpServer({ name: 'prodigy-mail', version: '1.0.0' });
  registerTools(server, callerFor(authorization));

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

// Streamable HTTP without sessions has no server-initiated stream to open and
// nothing to tear down, so say so rather than leaving a client hanging.
const notAllowed = (_req, res) =>
  rpcError(res, 405, 'This MCP endpoint is stateless — use POST.');
router.get('/', notAllowed);
router.delete('/', notAllowed);

module.exports = router;
