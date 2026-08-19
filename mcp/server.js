#!/usr/bin/env node
/**
 * Local (stdio) MCP server for Prodigy Educations Mail.
 *
 * Use this when your assistant runs on your own machine. If it can connect to
 * a URL instead — Gemini CLI, for example — point it straight at the app's own
 * endpoint and skip this entirely:
 *
 *   https://email.prodigyeducations.com/mcp
 *
 * Either way the tools are the same: they live in tools.cjs and reach the app
 * over its HTTP API with a personal access token.
 *
 *   PRODIGY_MAIL_URL    https://email.prodigyeducations.com
 *   PRODIGY_MAIL_TOKEN  pem_… (Account -> AI access tokens)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerTools } = require('./tools.cjs');

const BASE = (process.env.PRODIGY_MAIL_URL || 'https://email.prodigyeducations.com').replace(/\/+$/, '');
const TOKEN = process.env.PRODIGY_MAIL_TOKEN || '';

if (!TOKEN) {
  console.error(
    'PRODIGY_MAIL_TOKEN is not set.\n' +
      'Create one in the app under your avatar -> Change password -> AI access tokens,\n' +
      'then set it in your MCP client configuration.'
  );
  process.exit(1);
}

async function call(path, { method = 'GET', body, form } = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: payload });
  } catch (err) {
    throw new Error(`Could not reach ${BASE} — ${err.message}`);
  }

  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new Error(
      res.status === 404
        ? `${BASE} is not running the mail application (got a plain ${res.status}). Check ${BASE}/api/health`
        : `Unexpected ${res.status} response from ${BASE}`
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('The access token was rejected. Create a new one in the app.');
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

const server = new McpServer({ name: 'prodigy-mail', version: '1.0.0' });
registerTools(server, call);
await server.connect(new StdioServerTransport());
