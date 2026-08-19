'use strict';

/**
 * The tools an assistant gets, defined once and shared by both transports:
 * the local stdio server in this folder, and the remote endpoint the app
 * hosts at /mcp. Nothing here knows how it is being reached — it is handed a
 * `call(path, options)` that performs the authenticated HTTP request.
 */

const { z } = require('zod');



/** Plain text from the model becomes paragraphs the template can style. */
function toHtml(text) {
  const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text || '')
    .split(/\n{2,}/)
    .map((para) => `<p>${escape(para).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

/** MCP replies are text; JSON keeps them parseable by the model. */
const reply = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function registerTools(server, call) {
function trimMessage(m) {
  return {
    uid: m.uid,
    subject: m.subject,
    from: m.from,
    to: m.to,
    date: m.date,
    unread: m.seen === false,
    flagged: m.flagged,
    answered: m.answered,
    hasAttachments: m.hasAttachments,
  };
}

// ── Who am I, and which addresses can I use? ────────────────────────────────
  server.registerTool(
  'list_mailboxes',
  {
    title: 'List business emails',
    description:
      'The business email addresses the connected account can read and send from, ' +
      'including any shared team address. Returns the mailbox id needed by the other tools.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const me = await call('/api/auth/me');
    return reply({
      signedInAs: me.user,
      mailboxes: (me.mailboxes || []).map((m) => ({
        id: m.id,
        address: m.address,
        displayName: m.display_name,
        isDefault: m.is_default === 1,
        sharedWith: m.shared_with,
      })),
    });
  }
);

  server.registerTool(
  'list_folders',
  {
    title: 'List folders',
    description: 'Folders in a mailbox, with total and unread counts.',
    inputSchema: { mailboxId: z.number().int().optional().describe('Defaults to the default mailbox') },
    annotations: { readOnlyHint: true },
  },
  async ({ mailboxId }) => {
    const q = mailboxId ? `?mailboxId=${mailboxId}` : '';
    const { folders } = await call(`/api/mail/folders${q}`);
    return reply(folders.map((f) => ({ path: f.path, name: f.name, total: f.total, unread: f.unseen })));
  }
);

// ── Reading ────────────────────────────────────────────────────────────────
  server.registerTool(
  'list_messages',
  {
    title: 'List messages',
    description:
      'Messages in a folder, newest first. Use `search` to filter by sender, recipient, subject or body text. ' +
      'Returns headers only — call read_message for the body.',
    inputSchema: {
      mailboxId: z.number().int().optional(),
      folder: z.string().optional().describe('Defaults to INBOX'),
      search: z.string().optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ mailboxId, folder, search, page, pageSize }) => {
    const params = new URLSearchParams();
    if (mailboxId) params.set('mailboxId', mailboxId);
    params.set('path', folder || 'INBOX');
    if (search) params.set('search', search);
    params.set('page', page || 1);
    params.set('pageSize', pageSize || 25);
    const data = await call(`/api/mail/messages?${params}`);
    return reply({
      folder: data.path,
      total: data.total,
      page: data.page,
      messages: data.messages.map(trimMessage),
    });
  }
);

  server.registerTool(
  'read_message',
  {
    title: 'Read a message',
    description:
      'The full text of one message, by uid. Marks it read unless markRead is false. ' +
      'Also returns the identifiers needed to reply to it.',
    inputSchema: {
      uid: z.number().int().describe('From list_messages'),
      mailboxId: z.number().int().optional(),
      folder: z.string().optional().describe('Defaults to INBOX'),
      markRead: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ uid, mailboxId, folder, markRead }) => {
    const params = new URLSearchParams();
    if (mailboxId) params.set('mailboxId', mailboxId);
    params.set('path', folder || 'INBOX');
    params.set('uid', uid);
    if (markRead === false) params.set('markSeen', '0');
    const { message } = await call(`/api/mail/message?${params}`);
    return reply({
      uid: message.uid,
      folder: message.path,
      subject: message.subject,
      from: message.from,
      to: message.to,
      cc: message.cc,
      replyTo: message.replyTo,
      date: message.date,
      body: message.text || '',
      attachments: message.attachments,
      messageId: message.messageId,
      references: message.references,
    });
  }
);

  server.registerTool(
  'search_messages',
  {
    title: 'Search mail',
    description: 'Search a mailbox for text in the sender, recipient, subject or body.',
    inputSchema: {
      query: z.string().min(1),
      mailboxId: z.number().int().optional(),
      folder: z.string().optional(),
      pageSize: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, mailboxId, folder, pageSize }) => {
    const params = new URLSearchParams();
    if (mailboxId) params.set('mailboxId', mailboxId);
    params.set('path', folder || 'INBOX');
    params.set('search', query);
    params.set('pageSize', pageSize || 25);
    const data = await call(`/api/mail/messages?${params}`);
    return reply({ query, matches: data.total, messages: data.messages.map(trimMessage) });
  }
);

  server.registerTool(
  'get_signature',
  {
    title: 'Get my signature',
    description:
      'The signature block appended to everything this account sends. Useful to check ' +
      'what the recipient will see before drafting.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const { signature } = await call('/api/signature');
    return reply(signature);
  }
);

  server.registerTool(
  'preview_message',
  {
    title: 'Preview a message',
    description:
      'Render a draft exactly as it would be sent — company header, your signature and ' +
      'the footer — without sending anything. Prefer this before send_message.',
    inputSchema: { body: z.string().describe('The message text; blank lines separate paragraphs') },
    annotations: { readOnlyHint: true },
  },
  async ({ body }) => {
    const { html } = await call('/api/mail/preview', { method: 'POST', body: { bodyHtml: toHtml(body) } });
    return reply({ note: 'This is the exact HTML that would be delivered.', html });
  }
);

// ── Sending ────────────────────────────────────────────────────────────────

  server.registerTool(
  'send_message',
  {
    title: 'Send an email',
    description:
      'Send a new message from a business address. The company header, the sender signature ' +
      'and the Prodigy Educations footer are added automatically — do not write them into the body. ' +
      'This delivers real mail to real people: confirm the recipient and wording with the user first.',
    inputSchema: {
      to: z.string().describe('One or more addresses, comma separated'),
      subject: z.string(),
      body: z.string().describe('Plain text; blank lines separate paragraphs'),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      mailboxId: z.number().int().optional().describe('Which address to send from; defaults to the default one'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ to, subject, body, cc, bcc, mailboxId }) => {
    const form = new FormData();
    if (mailboxId) form.set('mailboxId', String(mailboxId));
    form.set('to', to);
    if (cc) form.set('cc', cc);
    if (bcc) form.set('bcc', bcc);
    form.set('subject', subject);
    form.set('bodyHtml', toHtml(body));
    const result = await call('/api/mail/send', { method: 'POST', form });
    return reply({
      sent: true,
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
      savedToSentFolder: Boolean(result.saved && result.saved.ok),
    });
  }
);

  server.registerTool(
  'reply_to_message',
  {
    title: 'Reply to a message',
    description:
      'Reply to a message read with read_message, keeping the conversation threaded and quoting ' +
      'the original. Signature and footer are added automatically. ' +
      'This delivers real mail: confirm the wording with the user first.',
    inputSchema: {
      uid: z.number().int().describe('The message being replied to'),
      body: z.string().describe('Your reply, plain text'),
      folder: z.string().optional().describe('Folder the original is in; defaults to INBOX'),
      mailboxId: z.number().int().optional(),
      replyAll: z.boolean().optional().describe('Also reply to everyone in To and Cc'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ uid, body, folder, mailboxId, replyAll }) => {
    const params = new URLSearchParams();
    if (mailboxId) params.set('mailboxId', mailboxId);
    params.set('path', folder || 'INBOX');
    params.set('uid', uid);
    params.set('markSeen', '0');
    const { message } = await call(`/api/mail/message?${params}`);

    const addresses = (list) => (list || []).map((a) => a.address).filter(Boolean);
    const to = addresses(message.replyTo && message.replyTo.length ? message.replyTo : message.from);
    const me = await call('/api/auth/me');
    const mine = new Set((me.mailboxes || []).map((m) => m.address.toLowerCase()));
    const cc = replyAll
      ? [...new Set([...addresses(message.to), ...addresses(message.cc)])].filter(
          (a) => !mine.has(a.toLowerCase()) && !to.includes(a)
        )
      : [];

    const quoted =
      `<p style="color:#5b6472;font-size:12px;margin:0 0 8px">On ${message.date}, ` +
      `${(message.from[0] && (message.from[0].name || message.from[0].address)) || 'they'} wrote:</p>` +
      toHtml(message.text || '');

    const form = new FormData();
    if (mailboxId) form.set('mailboxId', String(mailboxId));
    form.set('to', to.join(', '));
    if (cc.length) form.set('cc', cc.join(', '));
    form.set('subject', /^\s*Re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`);
    form.set('bodyHtml', toHtml(body));
    form.set('quotedHtml', quoted);
    form.set('inReplyTo', message.messageId || '');
    form.set('references', (message.references || []).join(' '));
    form.set('replyToUid', String(uid));
    form.set('path', folder || 'INBOX');

    const result = await call('/api/mail/send', { method: 'POST', form });
    return reply({
      sent: true,
      to: to.join(', '),
      cc: cc.join(', '),
      subject: form.get('subject'),
      messageId: result.messageId,
      savedToSentFolder: Boolean(result.saved && result.saved.ok),
    });
  }
);

// ── Housekeeping ───────────────────────────────────────────────────────────
  server.registerTool(
  'set_message_flag',
  {
    title: 'Flag or mark read',
    description: 'Mark a message read/unread or flagged/unflagged.',
    inputSchema: {
      uid: z.number().int(),
      flag: z.enum(['seen', 'flagged']),
      value: z.boolean(),
      folder: z.string().optional(),
      mailboxId: z.number().int().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ uid, flag, value, folder, mailboxId }) => {
    await call('/api/mail/flag', {
      method: 'POST',
      body: { uid, flag, value, path: folder || 'INBOX', mailboxId },
    });
    return reply({ ok: true, uid, flag, value });
  }
);

  server.registerTool(
  'list_sent',
  {
    title: 'Recently sent',
    description: 'What this account has sent through the platform, most recent first.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const { entries } = await call('/api/mail/sent-log');
    return reply(
      entries.map((e) => ({
        when: e.created_at,
        to: e.to_addr,
        subject: e.subject,
        status: e.status,
        error: e.error || undefined,
      }))
    );
  }
);

}

module.exports = { registerTools, toHtml };
