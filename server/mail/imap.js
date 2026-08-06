'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');

const IDLE_MS = 3 * 60 * 1000;

// One live connection per mailbox, reused across requests and closed after a
// few idle minutes. Operations on the same mailbox are serialised because an
// IMAP session can only run one command sequence at a time.
const pool = new Map();

function connectionOptions(mailbox) {
  return {
    host: mailbox.imap_host,
    port: Number(mailbox.imap_port) || 993,
    secure: !!mailbox.imap_secure,
    auth: { user: mailbox.imap_user, pass: mailbox.imap_password_plain },
    logger: false,
    emitLogs: false,
    tls: { rejectUnauthorized: process.env.IMAP_ALLOW_SELF_SIGNED !== '1' },
    socketTimeout: 60000,
    greetingTimeout: 20000,
    connectionTimeout: 20000,
  };
}

async function openClient(mailbox) {
  const client = new ImapFlow(connectionOptions(mailbox));
  client.on('error', () => {
    /* surfaced by the awaiting operation; nothing to do here */
  });
  await client.connect();
  return client;
}

function scheduleClose(entry) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pool.delete(entry.key);
    entry.client.logout().catch(() => entry.client.close());
  }, IDLE_MS);
  entry.timer.unref?.();
}

/**
 * Run `fn(client)` against the mailbox, reusing a pooled connection.
 * Calls on the same mailbox queue behind each other.
 */
async function withClient(mailbox, fn) {
  const key = String(mailbox.id);
  let entry = pool.get(key);

  if (!entry) {
    entry = { key, client: null, chain: Promise.resolve(), timer: null };
    pool.set(key, entry);
  }

  const run = entry.chain.then(async () => {
    clearTimeout(entry.timer);
    if (!entry.client || !entry.client.usable) {
      entry.client = await openClient(mailbox);
    }
    try {
      return await fn(entry.client);
    } catch (err) {
      // A dead socket poisons the pooled client — drop it so the next call reconnects.
      if (!entry.client?.usable) {
        pool.delete(key);
        try {
          entry.client?.close();
        } catch {
          /* already gone */
        }
        entry.client = null;
      }
      throw err;
    } finally {
      if (entry.client) scheduleClose(entry);
    }
  });

  entry.chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function closeAll() {
  for (const entry of pool.values()) {
    clearTimeout(entry.timer);
    entry.client?.logout().catch(() => entry.client?.close());
  }
  pool.clear();
}

/** Verify credentials without touching the pool. */
async function testConnection(mailbox) {
  const client = new ImapFlow(connectionOptions(mailbox));
  client.on('error', () => {});
  try {
    await client.connect();
    await client.list();
    await client.logout();
    return { ok: true };
  } catch (err) {
    try {
      client.close();
    } catch {
      /* ignore */
    }
    return { ok: false, error: err.message };
  }
}

const SPECIAL_ORDER = ['\\Inbox', '\\Sent', '\\Drafts', '\\Junk', '\\Trash', '\\Archive'];

async function listFolders(mailbox) {
  return withClient(mailbox, async (client) => {
    const list = await client.list();
    const folders = list
      .filter((f) => !f.flags?.has('\\Noselect'))
      .map((f) => ({
        path: f.path,
        name: f.name,
        specialUse: f.specialUse || (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : ''),
        subscribed: !!f.subscribed,
      }));
    folders.sort((a, b) => {
      const ai = SPECIAL_ORDER.indexOf(a.specialUse);
      const bi = SPECIAL_ORDER.indexOf(b.specialUse);
      if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.path.localeCompare(b.path);
    });
    return folders;
  });
}

async function folderStatus(mailbox, path = 'INBOX') {
  return withClient(mailbox, async (client) => {
    const status = await client.status(path, { messages: true, unseen: true });
    return { path, total: status.messages || 0, unseen: status.unseen || 0 };
  });
}

function addressList(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : value.value || [];
  return items.map((a) => ({ name: a.name || '', address: a.address || '' }));
}

/**
 * Page through a folder, newest first.
 * `search` (optional) does a server-side search over from/subject/body.
 */
async function listMessages(mailbox, { path = 'INBOX', page = 1, pageSize = 25, search = '' } = {}) {
  return withClient(mailbox, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      const box = client.mailbox;
      const total = box.exists || 0;
      let uids = null;

      if (search && search.trim()) {
        const term = search.trim();
        uids = await client.search(
          { or: [{ from: term }, { to: term }, { subject: term }, { body: term }] },
          { uid: true }
        );
        uids = (uids || []).sort((a, b) => b - a);
      }

      const totalCount = uids ? uids.length : total;
      const offset = (Math.max(1, page) - 1) * pageSize;
      const messages = [];

      if (totalCount === 0 || offset >= totalCount) {
        return { path, page, pageSize, total: totalCount, messages: [] };
      }

      let range;
      let useUid = false;
      if (uids) {
        const slice = uids.slice(offset, offset + pageSize);
        if (!slice.length) return { path, page, pageSize, total: totalCount, messages: [] };
        range = slice.join(',');
        useUid = true;
      } else {
        const end = total - offset; // newest-first paging over sequence numbers
        const start = Math.max(1, end - pageSize + 1);
        if (end < 1) return { path, page, pageSize, total: totalCount, messages: [] };
        range = `${start}:${end}`;
      }

      for await (const msg of client.fetch(
        range,
        { uid: true, envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true },
        { uid: useUid }
      )) {
        const env = msg.envelope || {};
        messages.push({
          uid: msg.uid,
          seq: msg.seq,
          subject: env.subject || '(no subject)',
          from: addressList(env.from),
          to: addressList(env.to),
          cc: addressList(env.cc),
          date: (env.date || msg.internalDate || new Date()).toISOString?.() || null,
          size: msg.size || 0,
          seen: msg.flags?.has('\\Seen') || false,
          flagged: msg.flags?.has('\\Flagged') || false,
          answered: msg.flags?.has('\\Answered') || false,
          hasAttachments: hasAttachment(msg.bodyStructure),
        });
      }

      messages.sort((a, b) => new Date(b.date) - new Date(a.date));
      return { path, page, pageSize, total: totalCount, messages };
    } finally {
      lock.release();
    }
  });
}

function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  if (Array.isArray(node.childNodes)) return node.childNodes.some(hasAttachment);
  return false;
}

const SANITIZE_OPTIONS = {
  // No <style> block: sanitize-html cannot filter its contents, and an
  // @import there would phone home to the sender. Inline style attributes
  // are kept, which is what real business mail relies on anyway.
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
    'span', 'font', 'center', 'u', 'hr', 'colgroup', 'col',
  ]),
  allowedAttributes: {
    '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing', 'dir'],
    a: ['href', 'name', 'target', 'title', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    font: ['color', 'size', 'face'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }),
  },
  allowedStyles: {
    '*': {
      color: [/.*/],
      'background-color': [/.*/],
      'text-align': [/.*/],
      'font-size': [/.*/],
      'font-family': [/.*/],
      'font-weight': [/.*/],
      'font-style': [/.*/],
      'text-decoration': [/.*/],
      'line-height': [/.*/],
      padding: [/.*/], 'padding-top': [/.*/], 'padding-bottom': [/.*/], 'padding-left': [/.*/], 'padding-right': [/.*/],
      margin: [/.*/], 'margin-top': [/.*/], 'margin-bottom': [/.*/], 'margin-left': [/.*/], 'margin-right': [/.*/],
      border: [/.*/], 'border-top': [/.*/], 'border-bottom': [/.*/], 'border-left': [/.*/], 'border-right': [/.*/],
      'border-radius': [/.*/], 'border-collapse': [/.*/], 'border-color': [/.*/],
      width: [/.*/], 'max-width': [/.*/], height: [/.*/], display: [/.*/],
      'vertical-align': [/.*/], 'letter-spacing': [/.*/], 'white-space': [/.*/], 'list-style': [/.*/],
    },
  },
};

function cleanHtml(html) {
  return sanitizeHtml(html || '', SANITIZE_OPTIONS);
}

async function getMessage(mailbox, { path = 'INBOX', uid, markSeen = true } = {}) {
  return withClient(mailbox, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      const download = await client.download(String(uid), undefined, { uid: true });
      if (!download || !download.content) throw new Error('Message not found');

      const parsed = await simpleParser(download.content, {
        skipImageLinks: false,
        skipTextToHtml: false,
      });

      // Inline images (logos, signature photos) travel as cid: references —
      // rewrite them to data: URIs so the reading pane renders them.
      const inline = new Map();
      for (const att of parsed.attachments || []) {
        if (att.cid && att.related !== false && att.content) {
          inline.set(att.cid, `data:${att.contentType};base64,${att.content.toString('base64')}`);
        }
      }
      let html = parsed.html || (parsed.textAsHtml || '');
      for (const [cid, dataUri] of inline) {
        html = html.split(`cid:${cid}`).join(dataUri);
      }

      const attachments = (parsed.attachments || [])
        .filter((a) => !a.cid || a.contentDisposition === 'attachment')
        .map((a, index) => ({
          index,
          filename: a.filename || `attachment-${index + 1}`,
          contentType: a.contentType,
          size: a.size,
        }));

      if (markSeen) {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }

      return {
        uid: Number(uid),
        path,
        subject: parsed.subject || '(no subject)',
        from: addressList(parsed.from),
        to: addressList(parsed.to),
        cc: addressList(parsed.cc),
        bcc: addressList(parsed.bcc),
        replyTo: addressList(parsed.replyTo),
        date: parsed.date ? parsed.date.toISOString() : null,
        messageId: parsed.messageId || '',
        references: parsed.references
          ? Array.isArray(parsed.references) ? parsed.references : [parsed.references]
          : [],
        inReplyTo: parsed.inReplyTo || '',
        html: cleanHtml(html),
        text: parsed.text || '',
        attachments,
      };
    } finally {
      lock.release();
    }
  });
}

async function getAttachment(mailbox, { path, uid, index }) {
  return withClient(mailbox, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      const download = await client.download(String(uid), undefined, { uid: true });
      const parsed = await simpleParser(download.content);
      const list = (parsed.attachments || []).filter(
        (a) => !a.cid || a.contentDisposition === 'attachment'
      );
      const att = list[Number(index)];
      if (!att) throw new Error('Attachment not found');
      return {
        filename: att.filename || `attachment-${Number(index) + 1}`,
        contentType: att.contentType || 'application/octet-stream',
        content: att.content,
      };
    } finally {
      lock.release();
    }
  });
}

async function setFlag(mailbox, { path, uid, flag, value }) {
  return withClient(mailbox, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      if (value) await client.messageFlagsAdd(String(uid), [flag], { uid: true });
      else await client.messageFlagsRemove(String(uid), [flag], { uid: true });
      return { ok: true };
    } finally {
      lock.release();
    }
  });
}

async function moveMessage(mailbox, { path, uid, target }) {
  return withClient(mailbox, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      await client.messageMove(String(uid), target, { uid: true });
      return { ok: true };
    } finally {
      lock.release();
    }
  });
}

async function deleteMessage(mailbox, { path, uid }) {
  return withClient(mailbox, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      await client.messageDelete(String(uid), { uid: true });
      return { ok: true };
    } finally {
      lock.release();
    }
  });
}

/** Best-effort copy of an outgoing message into the account's Sent folder. */
async function appendToSent(mailbox, raw, preferredPath = '') {
  return withClient(mailbox, async (client) => {
    let target = preferredPath;
    if (!target) {
      const list = await client.list();
      const sent = list.find((f) => f.specialUse === '\\Sent');
      target = sent ? sent.path : list.find((f) => /^sent/i.test(f.name))?.path || '';
    }
    if (!target) return { ok: false, reason: 'No Sent folder found' };
    await client.append(target, raw, ['\\Seen']);
    return { ok: true, path: target };
  });
}

module.exports = {
  withClient,
  testConnection,
  listFolders,
  folderStatus,
  listMessages,
  getMessage,
  getAttachment,
  setFlag,
  moveMessage,
  deleteMessage,
  appendToSent,
  cleanHtml,
  closeAll,
};
