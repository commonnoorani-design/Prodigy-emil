/* Prodigy Educations Mail — browser client */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    user: null,
    brand: null,
    mailboxes: [],
    mailboxId: null,
    folders: [],
    folder: 'INBOX',
    page: 1,
    pageSize: 25,
    total: 0,
    search: '',
    messages: [],
    current: null,
    signature: null,
    attachments: [],
    view: 'mail',
  };

  // ───────────────────────── HTTP helpers ─────────────────────────
  async function api(path, options = {}) {
    const opts = { credentials: 'same-origin', ...options };
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    const type = res.headers.get('content-type') || '';
    const isJson = type.includes('application/json');
    const data = isJson ? await res.json().catch(() => ({})) : {};
    if (!res.ok) {
      // Every /api route answers in JSON, including its 404s. Anything else
      // means the request never reached the Node app — usually the web server
      // is serving the public/ folder as plain files with nothing behind it.
      const error = new Error(
        isJson ? data.error || `Request failed (${res.status})` : serverUnreachableMessage(res.status)
      );
      error.status = res.status;
      error.reason = data.reason || '';
      // Losing the session mid-use used to reload the page, which showed the
      // sign-in form with no word of why — and reloaded again on the next
      // failure. Say what happened, once.
      if (res.status === 401 && state.user) endSession(error.reason);
      throw error;
    }
    return data;
  }

  /** Is a cookie the page is allowed to read present? */
  function hasCookie(name) {
    return document.cookie.split('; ').some((c) => c.startsWith(`${name}=`));
  }

  // Sign-in sets a second, readable cookie alongside the httpOnly session one.
  // Between that and the server's own account of the 401, the page can say
  // which half of the handshake broke instead of silently going back to the
  // form — the failure a person describes as "it signs me out immediately".
  function signedOutMessage(reason) {
    if (reason === 'unknown_session') {
      return (
        'The server did not recognise the session it had just created. ' +
        'That happens when the app restarts without a permanent data folder — ' +
        'check DATA_DIR in the deployment settings.'
      );
    }
    if (!hasCookie('pe_signed_in')) {
      return (
        'Your browser did not keep the sign-in cookie, so the very next ' +
        'request arrived signed out. Allow cookies for ' + location.host +
        ' — private browsing, a cookie blocker or an in-app browser will each ' +
        'do this — then sign in again.'
      );
    }
    return (
      'The sign-in cookie was set but not sent back. Something between this ' +
      'browser and the site is stripping it — try another browser or network.'
    );
  }

  function endSession(reason) {
    state.user = null;
    state.mailboxes = [];
    state.current = null;
    showLogin(reason ? signedOutMessage(reason) : 'Your session has ended. Please sign in again.');
  }

  function serverUnreachableMessage(status) {
    if (status === 404) {
      return (
        'The application server is not answering at this address — only the ' +
        'static files are being served. Start the Node.js app and point the ' +
        'domain at it, then check ' + location.origin + '/api/health'
      );
    }
    if (status === 502 || status === 503 || status === 504) {
      return `The application server is not running (${status}). Start it, then check ${location.origin}/api/health`;
    }
    return `The application server returned ${status} instead of a response. Check the app's log.`;
  }

  let toastTimer;
  function toast(message, kind = '') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  }

  const fullDate = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }) : '');
  const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const who = (list) => (list && list.length ? list.map((a) => a.name || a.address).join(', ') : '');
  const addr = (list) => (list && list.length ? list.map((a) => a.address).filter(Boolean).join(', ') : '');

  // ───────────────────────── Session ─────────────────────────
  async function boot({ justSignedIn = false } = {}) {
    try {
      const data = await api('/api/auth/me');
      state.user = data.user;
      state.brand = data.brand;
      state.signature = data.signature;
      state.mailboxes = data.mailboxes || [];
      state.mailboxId = (state.mailboxes.find((m) => m.is_default) || state.mailboxes[0] || {}).id || null;
      showApp();
    } catch (err) {
      // A password that was just accepted, followed by a request that arrives
      // signed out, is not a sign-in problem — it is the session being lost in
      // between. Never send someone back to the form over that without saying so.
      if (err.status && err.status !== 401) return showLogin(err.message);
      if (justSignedIn) return showLogin(signedOutMessage(err.reason));
      // A brand-new installation has no accounts at all — offer to create the
      // first one rather than a sign-in form nobody has credentials for.
      try {
        const { needsSetup } = await api('/api/setup/status');
        if (needsSetup) return showSetup();
      } catch {
        /* older build or unreachable — fall through to the sign-in form */
      }
      showLogin();
    }
  }

  function showLogin(message = '') {
    $('#setup-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    $('#app-view').classList.add('hidden');
    const err = $('#login-error');
    err.textContent = message;
    err.classList.toggle('hidden', !message);
    $('#login-email').focus();
  }

  function showSetup() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.add('hidden');
    $('#setup-view').classList.remove('hidden');
    $('#setup-name').focus();
  }

  function showApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');

    const initials = (state.user.name || '?')
      .split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
    $('#user-initials').textContent = initials || 'PE';
    $('#dd-name').textContent = state.user.name;
    $('#dd-email').textContent = state.user.loginEmail;
    $('#dd-role').textContent = state.user.role === 'admin' ? 'Administrator' : 'User';
    if (state.brand) {
      $('#brand-site').textContent = state.brand.websiteLabel;
      $$('.brand').forEach((a) => (a.href = state.brand.website));
    }

    const isAdmin = state.user.role === 'admin';
    $('#nav-admin').classList.toggle('hidden', !isAdmin);
    $('#dd-admin').classList.toggle('hidden', !isAdmin);

    renderMailboxSelect();
    fillSignatureForm();
    refreshAvatar();

    if (state.user.mustChangePassword) {
      toast('Please set a new password for your account.', 'error');
      navigate('account');
    } else if (!state.mailboxes.length) {
      toast(
        isAdmin
          ? 'No business email assigned yet — add one under Administration → Business emails.'
          : 'No business email is assigned to your account yet. Please contact an administrator.',
        'error'
      );
      navigate(isAdmin ? 'admin' : 'signature');
    } else {
      loadFolders();
    }
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.classList.add('hidden');
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: { email: $('#login-email').value, password: $('#login-password').value },
      });
      $('#login-password').value = '';
      await boot({ justSignedIn: true });
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });

  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#setup-error');
    err.classList.add('hidden');
    if ($('#setup-password').value !== $('#setup-confirm').value) {
      err.textContent = 'The two passwords do not match.';
      err.classList.remove('hidden');
      return;
    }
    try {
      await api('/api/setup', {
        method: 'POST',
        body: {
          name: $('#setup-name').value,
          email: $('#setup-email').value,
          password: $('#setup-password').value,
        },
      });
      await boot({ justSignedIn: true });
      toast('Administrator created — you are signed in.', 'success');
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  // ───────────────────────── Navigation ─────────────────────────
  function navigate(view) {
    state.view = view;
    ['mail', 'signature', 'admin', 'account'].forEach((v) => {
      const el = $(`#view-${v}`);
      if (el) el.classList.toggle('hidden', v !== view);
    });
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
    $('#user-dropdown').classList.add('hidden');
    $('#sidebar').classList.remove('open');
    if (view === 'signature') refreshSignaturePreview();
    if (view === 'admin') loadAdmin();
    if (view === 'account') loadTokens();
  }

  $$('[data-nav]').forEach((btn) => btn.addEventListener('click', () => navigate(btn.dataset.nav)));

  $('#user-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#user-dropdown').classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-menu')) $('#user-dropdown').classList.add('hidden');
  });
  $('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // ───────────────────────── Mailboxes & folders ─────────────────────────
  function renderMailboxSelect() {
    const select = $('#mailbox-select');
    const from = $('#c-from');
    const options = state.mailboxes
      .map((m) => `<option value="${m.id}">${esc(m.address)}</option>`)
      .join('');
    select.innerHTML = options || '<option value="">No business email assigned</option>';
    from.innerHTML = state.mailboxes
      .map((m) => `<option value="${m.id}">${esc(m.display_name ? `${m.display_name} <${m.address}>` : m.address)}</option>`)
      .join('');
    if (state.mailboxId) {
      select.value = String(state.mailboxId);
      from.value = String(state.mailboxId);
    }
  }

  $('#mailbox-select').addEventListener('change', (e) => {
    state.mailboxId = Number(e.target.value) || null;
    $('#c-from').value = e.target.value;
    state.folder = 'INBOX';
    state.page = 1;
    loadFolders();
  });

  async function loadFolders() {
    if (!state.mailboxId) return;
    $('#folder-list').innerHTML = '<li class="muted" style="padding:8px 12px">Connecting…</li>';
    try {
      const { folders } = await api(`/api/mail/folders?mailboxId=${state.mailboxId}`);
      state.folders = folders;
      renderFolders();
      loadMessages();
    } catch (err) {
      $('#folder-list').innerHTML = `<li style="padding:8px 12px;color:#c0392b">${esc(err.message)}</li>`;
      toast(`Mailbox connection failed: ${err.message}`, 'error');
    }
  }

  function folderIcon(f) {
    const map = { '\\Inbox': '📥', '\\Sent': '📤', '\\Drafts': '📝', '\\Junk': '🚫', '\\Trash': '🗑', '\\Archive': '🗄' };
    return map[f.specialUse] || '📁';
  }

  function renderFolders() {
    $('#folder-list').innerHTML = state.folders
      .map(
        (f) => `<li><button data-path="${esc(f.path)}" class="${f.path === state.folder ? 'active' : ''}">
            <span>${folderIcon(f)}</span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name || f.path)}</span>
            ${f.unseen ? `<span class="count">${f.unseen}</span>` : ''}
          </button></li>`
      )
      .join('');
    $$('#folder-list button').forEach((btn) =>
      btn.addEventListener('click', () => {
        state.folder = btn.dataset.path;
        state.page = 1;
        $('#sidebar').classList.remove('open');
        loadMessages();
      })
    );
  }

  // ───────────────────────── Message list ─────────────────────────
  async function loadMessages() {
    if (!state.mailboxId) return;
    navigate('mail');
    renderFolders();
    const current = state.folders.find((f) => f.path === state.folder);
    $('#list-title').textContent = current ? current.name || current.path : state.folder;
    $('#message-list').innerHTML = '<div class="muted" style="padding:20px;text-align:center">Loading…</div>';

    const params = new URLSearchParams({
      mailboxId: state.mailboxId,
      path: state.folder,
      page: state.page,
      pageSize: state.pageSize,
    });
    if (state.search) params.set('search', state.search);

    try {
      const data = await api(`/api/mail/messages?${params}`);
      state.messages = data.messages;
      state.total = data.total;
      renderMessages();
    } catch (err) {
      $('#message-list').innerHTML = `<div style="padding:20px;color:#c0392b">${esc(err.message)}</div>`;
    }
  }

  function renderMessages() {
    const list = $('#message-list');
    if (!state.messages.length) {
      list.innerHTML = `<div class="muted" style="padding:28px;text-align:center">${
        state.search ? 'No messages match your search.' : 'This folder is empty.'
      }</div>`;
    } else {
      list.innerHTML = state.messages
        .map(
          (m) => `<button class="msg ${m.seen ? '' : 'unread'} ${state.current && state.current.uid === m.uid ? 'active' : ''}" data-uid="${m.uid}">
            <div class="msg-top">
              ${m.seen ? '' : '<span class="unread-dot"></span>'}
              <span class="msg-from">${esc(who(m.from) || '(unknown sender)')}</span>
              <span class="msg-date">${esc(formatDate(m.date))}</span>
            </div>
            <div class="msg-subject">${esc(m.subject)}</div>
            ${m.hasAttachments || m.flagged || m.answered
              ? `<div class="msg-badges">${m.hasAttachments ? '📎' : ''}${m.flagged ? ' ★' : ''}${m.answered ? ' ↩' : ''}</div>`
              : ''}
          </button>`
        )
        .join('');
      $$('.msg', list).forEach((btn) =>
        btn.addEventListener('click', () => openMessage(Number(btn.dataset.uid)))
      );
    }

    const start = (state.page - 1) * state.pageSize + 1;
    const end = Math.min(state.page * state.pageSize, state.total);
    $('#page-info').textContent = state.total ? `${start}–${end} of ${state.total}` : '—';
    $('#prev-page').disabled = state.page <= 1;
    $('#next-page').disabled = end >= state.total;
  }

  $('#prev-page').addEventListener('click', () => {
    if (state.page > 1) { state.page--; loadMessages(); }
  });
  $('#next-page').addEventListener('click', () => { state.page++; loadMessages(); });
  $('#refresh-list').addEventListener('click', loadMessages);
  $('#refresh-folders').addEventListener('click', loadFolders);

  let searchTimer;
  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim();
      state.page = 1;
      loadMessages();
    }, 450);
  });

  // ───────────────────────── Reading pane ─────────────────────────
  async function openMessage(uid) {
    $('#read-empty').classList.add('hidden');
    $('#reader').classList.remove('hidden');
    $('#read-pane').classList.add('mobile-open');
    $('#r-subject').textContent = 'Loading…';
    $('#r-body').srcdoc = '';

    try {
      const { message } = await api(
        `/api/mail/message?mailboxId=${state.mailboxId}&path=${encodeURIComponent(state.folder)}&uid=${uid}`
      );
      state.current = message;
      renderMessage(message);
      const row = state.messages.find((m) => m.uid === uid);
      if (row) row.seen = true;
      renderMessages();
      const folder = state.folders.find((f) => f.path === state.folder);
      if (folder && folder.unseen > 0 && row) { folder.unseen -= 1; renderFolders(); }
    } catch (err) {
      $('#r-subject').textContent = 'Could not open this message';
      toast(err.message, 'error');
    }
  }

  function renderMessage(m) {
    $('#r-subject').textContent = m.subject;
    $('#r-from').textContent = who(m.from) || addr(m.from);
    $('#r-from-addr').textContent = addr(m.from) ? `<${addr(m.from)}>` : '';
    const to = addr(m.to);
    const cc = addr(m.cc);
    $('#r-to').textContent = `To: ${to || '—'}${cc ? ` · Cc: ${cc}` : ''}`;
    $('#r-date').textContent = fullDate(m.date);

    const box = $('#r-attachments');
    if (m.attachments && m.attachments.length) {
      box.classList.remove('hidden');
      box.innerHTML = m.attachments
        .map(
          (a) => `<a href="/api/mail/attachment?mailboxId=${state.mailboxId}&path=${encodeURIComponent(m.path)}&uid=${m.uid}&index=${a.index}"
                     download>📎 ${esc(a.filename)} <span class="muted">${bytes(a.size || 0)}</span></a>`
        )
        .join('');
    } else {
      box.classList.add('hidden');
      box.innerHTML = '';
    }

    // The server already sanitises this HTML; the sandboxed frame is the
    // second line of defence (no scripts, no same-origin access).
    $('#r-body').srcdoc = `<!doctype html><html><head><meta charset="utf-8">
      <base target="_blank">
      <style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#12161c;margin:18px 22px;}
      img{max-width:100%;height:auto}table{max-width:100%}a{color:#1e3a63}</style></head>
      <body>${m.html || `<pre style="white-space:pre-wrap;font:inherit">${esc(m.text)}</pre>`}</body></html>`;

    $('#flag-btn').textContent = m.flagged ? '★ Unflag' : '☆ Flag';
  }

  $('#flag-btn').addEventListener('click', async () => {
    if (!state.current) return;
    const next = !state.current.flagged;
    try {
      await api('/api/mail/flag', {
        method: 'POST',
        body: { mailboxId: state.mailboxId, path: state.current.path, uid: state.current.uid, flag: 'flagged', value: next },
      });
      state.current.flagged = next;
      const row = state.messages.find((m) => m.uid === state.current.uid);
      if (row) row.flagged = next;
      $('#flag-btn').textContent = next ? '★ Unflag' : '☆ Flag';
      renderMessages();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ───────────────── Print / save the open message ─────────────────
  /** The open message, described the way the printable sheet wants it. */
  function printableDoc() {
    const m = state.current;
    return {
      subject: m.subject,
      from: [who(m.from), addr(m.from) ? `<${addr(m.from)}>` : ''].filter(Boolean).join(' '),
      to: addr(m.to),
      cc: addr(m.cc),
      date: fullDate(m.date),
      attachments: (m.attachments || []).map((a) => `${a.filename} (${bytes(a.size || 0)})`),
      bodyHtml: m.html || `<pre>${esc(m.text || '')}</pre>`,
      brand: state.brand || {},
    };
  }

  $('#print-btn').addEventListener('click', async () => {
    if (!state.current) return;
    try {
      await MailExport.print(printableDoc());
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#png-btn').addEventListener('click', async (e) => {
    if (!state.current) return;
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const { dropped } = await MailExport.png(printableDoc());
      toast(
        dropped
          ? `Saved as PNG — ${dropped} image${dropped > 1 ? 's' : ''} hosted elsewhere could not be included.`
          : 'Saved as PNG',
        dropped ? '' : 'success'
      );
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#delete-btn').addEventListener('click', async () => {
    if (!state.current) return;
    if (!confirm('Move this message to Trash?')) return;
    try {
      const trash = state.folders.find((f) => f.specialUse === '\\Trash');
      if (trash && trash.path !== state.folder) {
        await api('/api/mail/move', {
          method: 'POST',
          body: { mailboxId: state.mailboxId, path: state.current.path, uid: state.current.uid, target: trash.path },
        });
      } else {
        await api(
          `/api/mail/message?mailboxId=${state.mailboxId}&path=${encodeURIComponent(state.current.path)}&uid=${state.current.uid}`,
          { method: 'DELETE' }
        );
      }
      toast('Message deleted', 'success');
      closeReader();
      loadMessages();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  function closeReader() {
    state.current = null;
    $('#reader').classList.add('hidden');
    $('#read-empty').classList.remove('hidden');
    $('#read-pane').classList.remove('mobile-open');
  }

  // ───────────────────────── Compose ─────────────────────────
  const composeModal = $('#compose-modal');

  function openCompose({ to = '', cc = '', subject = '', body = '', quotedHtml = '', quotedText = '', inReplyTo = '', references = [], replyToUid = '', path = '', title = 'New message' } = {}) {
    if (!state.mailboxes.length) {
      toast('No business email is assigned to your account yet.', 'error');
      return;
    }
    $('#compose-title').textContent = title;
    $('#c-to').value = to;
    $('#c-cc').value = cc;
    $('#c-bcc').value = '';
    $('#c-subject').value = subject;
    $('#c-body').innerHTML = body || '<p><br></p>';
    $('#c-body').dataset.placeholder = 'Write your message…';
    $('#c-from').value = String(state.mailboxId || '');
    $('#cc-row').classList.toggle('hidden', !cc);
    $('#bcc-row').classList.add('hidden');
    $('#compose-error').classList.add('hidden');

    composeModal.dataset.inReplyTo = inReplyTo;
    composeModal.dataset.references = (references || []).join(' ');
    composeModal.dataset.replyToUid = replyToUid;
    composeModal.dataset.path = path;
    $('#c-quoted').innerHTML = quotedHtml;
    composeModal.dataset.quotedText = quotedText;
    $('#c-quoted-wrap').classList.toggle('hidden', !quotedHtml);
    $('#c-quoted').classList.add('hidden');
    $('#toggle-quote').textContent = 'Show quoted message';

    state.attachments = [];
    renderAttachments();
    composeModal.classList.remove('hidden');
    setTimeout(() => (to ? $('#c-body') : $('#c-to')).focus(), 40);
  }

  function closeCompose() {
    composeModal.classList.add('hidden');
    state.attachments = [];
  }

  $('#compose-btn').addEventListener('click', () => openCompose({}));
  $('#compose-close').addEventListener('click', closeCompose);
  $('#compose-discard').addEventListener('click', () => {
    if (confirm('Discard this message?')) closeCompose();
  });
  $('#toggle-cc').addEventListener('click', () => {
    $('#cc-row').classList.toggle('hidden');
    $('#bcc-row').classList.toggle('hidden');
  });
  $('#toggle-quote').addEventListener('click', () => {
    const q = $('#c-quoted');
    q.classList.toggle('hidden');
    $('#toggle-quote').textContent = q.classList.contains('hidden') ? 'Show quoted message' : 'Hide quoted message';
  });

  $$('.editor-toolbar [data-cmd]').forEach((btn) =>
    btn.addEventListener('click', () => {
      $('#c-body').focus();
      document.execCommand(btn.dataset.cmd, false, null);
    })
  );
  $('#tb-link').addEventListener('click', () => {
    const url = prompt('Link address (https://…)');
    if (!url) return;
    $('#c-body').focus();
    document.execCommand('createLink', false, url);
  });

  $('#c-files').addEventListener('change', (e) => {
    for (const file of e.target.files) state.attachments.push(file);
    e.target.value = '';
    renderAttachments();
  });

  function renderAttachments() {
    $('#attach-list').innerHTML = state.attachments
      .map((f, i) => `<li>${esc(f.name)} <span class="muted">${bytes(f.size)}</span><button type="button" data-i="${i}">✕</button></li>`)
      .join('');
    $$('#attach-list button').forEach((b) =>
      b.addEventListener('click', () => {
        state.attachments.splice(Number(b.dataset.i), 1);
        renderAttachments();
      })
    );
  }

  function quotedFor(m) {
    const header = `On ${fullDate(m.date)}, ${esc(who(m.from) || addr(m.from))} wrote:`;
    return {
      quotedHtml: `<p style="color:#5b6472;font-size:12px;margin:0 0 8px">${header}</p>${m.html || esc(m.text)}`,
      quotedText: `\n\nOn ${fullDate(m.date)}, ${who(m.from) || addr(m.from)} wrote:\n${(m.text || '')
        .split('\n').map((l) => `> ${l}`).join('\n')}`,
    };
  }

  function replyPrefix(subject, prefix) {
    const re = new RegExp(`^\\s*${prefix}:`, 'i');
    return re.test(subject) ? subject : `${prefix}: ${subject}`;
  }

  $('#reply-btn').addEventListener('click', () => {
    const m = state.current;
    if (!m) return;
    const q = quotedFor(m);
    openCompose({
      title: 'Reply',
      to: addr(m.replyTo && m.replyTo.length ? m.replyTo : m.from),
      subject: replyPrefix(m.subject, 'Re'),
      inReplyTo: m.messageId,
      references: m.references,
      replyToUid: m.uid,
      path: m.path,
      ...q,
    });
  });

  $('#reply-all-btn').addEventListener('click', () => {
    const m = state.current;
    if (!m) return;
    const mine = new Set(state.mailboxes.map((x) => x.address.toLowerCase()));
    const to = (m.replyTo && m.replyTo.length ? m.replyTo : m.from).map((a) => a.address);
    const cc = [...(m.to || []), ...(m.cc || [])]
      .map((a) => a.address)
      .filter((a) => a && !mine.has(a.toLowerCase()) && !to.includes(a));
    const q = quotedFor(m);
    openCompose({
      title: 'Reply all',
      to: to.join(', '),
      cc: [...new Set(cc)].join(', '),
      subject: replyPrefix(m.subject, 'Re'),
      inReplyTo: m.messageId,
      references: m.references,
      replyToUid: m.uid,
      path: m.path,
      ...q,
    });
  });

  $('#forward-btn').addEventListener('click', () => {
    const m = state.current;
    if (!m) return;
    const header =
      `<p style="color:#5b6472;font-size:12px;margin:0 0 8px">---------- Forwarded message ----------<br>` +
      `From: ${esc(who(m.from))} &lt;${esc(addr(m.from))}&gt;<br>Date: ${esc(fullDate(m.date))}<br>` +
      `Subject: ${esc(m.subject)}<br>To: ${esc(addr(m.to))}</p>`;
    openCompose({
      title: 'Forward',
      subject: replyPrefix(m.subject, 'Fwd'),
      quotedHtml: header + (m.html || esc(m.text)),
      quotedText: `\n\n---------- Forwarded message ----------\nFrom: ${who(m.from)} <${addr(m.from)}>\nSubject: ${m.subject}\n\n${m.text || ''}`,
    });
  });

  $('#compose-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#compose-error');
    err.classList.add('hidden');

    const form = new FormData();
    form.set('mailboxId', $('#c-from').value);
    form.set('to', $('#c-to').value);
    form.set('cc', $('#c-cc').value);
    form.set('bcc', $('#c-bcc').value);
    form.set('subject', $('#c-subject').value);
    form.set('bodyHtml', $('#c-body').innerHTML);
    form.set('quotedHtml', $('#c-quoted').innerHTML);
    form.set('quotedText', composeModal.dataset.quotedText || '');
    form.set('inReplyTo', composeModal.dataset.inReplyTo || '');
    form.set('references', composeModal.dataset.references || '');
    form.set('replyToUid', composeModal.dataset.replyToUid || '');
    form.set('path', composeModal.dataset.path || '');
    state.attachments.forEach((f) => form.append('attachments', f, f.name));

    const btn = $('#send-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const result = await api('/api/mail/send', { method: 'POST', body: form });
      closeCompose();
      toast(
        result.saved && result.saved.ok ? 'Message sent and saved to Sent.' : 'Message sent.',
        'success'
      );
      if (state.folder !== 'INBOX') loadMessages();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send';
    }
  });

  $('#preview-btn').addEventListener('click', async () => {
    try {
      const { html } = await api('/api/mail/preview', {
        method: 'POST',
        body: { bodyHtml: $('#c-body').innerHTML, quotedHtml: $('#c-quoted').innerHTML },
      });
      $('#preview-frame').srcdoc = html;
      $('#preview-modal').classList.remove('hidden');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#preview-close').addEventListener('click', () => $('#preview-modal').classList.add('hidden'));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#preview-modal').classList.contains('hidden')) $('#preview-modal').classList.add('hidden');
    else if (!composeModal.classList.contains('hidden')) closeCompose();
  });

  // ───────────────────────── Signature ─────────────────────────
  function fillSignatureForm() {
    const s = state.signature || {};
    $('#sig-name').value = s.full_name || state.user.name || '';
    $('#sig-designation').value = s.designation || '';
    $('#sig-email').value = s.email || '';
    $('#sig-phone').value = s.phone || '';
    $('#sig-meeting').value = s.meeting_link || '';
    const type = s.phone_type || 'call_sms_whatsapp';
    const radio = $(`#phone-type-set input[value="${type}"]`);
    if (radio) radio.checked = true;
    refreshAvatar();
  }

  function refreshAvatar() {
    const s = state.signature || {};
    const src = s.photo_file ? `/uploads/${encodeURIComponent(s.photo_file)}?v=${Date.now()}` : '/assets/avatar-placeholder.svg';
    $('#dp-img').src = src;
    const btn = $('#user-btn');
    btn.innerHTML = s.photo_file
      ? `<img src="${src}" alt="" />`
      : `<span id="user-initials">${esc((state.user.name || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase())}</span>`;
  }

  $('#signature-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#sig-error');
    err.classList.add('hidden');
    try {
      const { signature } = await api('/api/signature', {
        method: 'PUT',
        body: {
          fullName: $('#sig-name').value,
          designation: $('#sig-designation').value,
          email: $('#sig-email').value,
          phone: $('#sig-phone').value,
          phoneType: ($('#phone-type-set input:checked') || {}).value || 'call_sms_whatsapp',
          meetingLink: $('#sig-meeting').value,
        },
      });
      state.signature = signature;
      $('#sig-saved').classList.remove('hidden');
      setTimeout(() => $('#sig-saved').classList.add('hidden'), 2500);
      refreshSignaturePreview();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });

  $('#dp-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const form = new FormData();
    form.append('photo', file, file.name);
    try {
      const { signature } = await api('/api/signature/photo', { method: 'POST', body: form });
      state.signature = signature;
      refreshAvatar();
      refreshSignaturePreview();
      toast('Profile picture updated', 'success');
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });

  $('#dp-remove').addEventListener('click', async () => {
    try {
      const { signature } = await api('/api/signature/photo', { method: 'DELETE' });
      state.signature = signature;
      refreshAvatar();
      refreshSignaturePreview();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });

  async function refreshSignaturePreview() {
    try {
      const [sig, mail] = await Promise.all([
        api('/api/signature/preview'),
        api('/api/signature/preview-email'),
      ]);
      $('#sig-preview').innerHTML = sig.html;
      $('#email-preview').srcdoc = mail.html;
    } catch {
      /* preview is non-critical */
    }
  }

  $$('[data-preview]').forEach((tab) =>
    tab.addEventListener('click', () => {
      $$('[data-preview]').forEach((t) => t.classList.toggle('active', t === tab));
      const showEmail = tab.dataset.preview === 'email';
      $('#sig-preview').classList.toggle('hidden', showEmail);
      $('#email-preview').classList.toggle('hidden', !showEmail);
    })
  );

  // ───────────────────────── Account ─────────────────────────
  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#p-msg');
    msg.className = 'form-note';
    if ($('#p-new').value !== $('#p-confirm').value) {
      msg.textContent = 'The two new passwords do not match.';
      msg.classList.add('error');
      msg.classList.remove('hidden');
      return;
    }
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: $('#p-current').value, newPassword: $('#p-new').value },
      });
      e.target.reset();
      msg.textContent = 'Password updated.';
      msg.classList.remove('hidden');
      state.user.mustChangePassword = false;
      toast('Password updated', 'success');
    } catch (ex) {
      msg.textContent = ex.message;
      msg.classList.add('error');
      msg.classList.remove('hidden');
    }
  });

  // ───────────────────────── AI access tokens ─────────────────────────
  async function loadTokens() {
    try {
      const { tokens } = await api('/api/auth/tokens');
      $('#tokens-table tbody').innerHTML = tokens.length
        ? tokens
            .map(
              (t) => `<tr>
                <td><strong>${esc(t.name)}</strong></td>
                <td class="muted">${esc(t.created_at)}</td>
                <td class="muted">${t.last_used_at ? esc(t.last_used_at) : 'never'}</td>
                <td><div class="actions"><button class="btn btn-ghost danger" data-revoke="${t.id}">Revoke</button></div></td>
              </tr>`
            )
            .join('')
        : '<tr><td colspan="4" class="muted" style="padding:16px;text-align:center">No tokens yet.</td></tr>';
      $$('#tokens-table [data-revoke]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Revoke this token? Anything using it stops working immediately.')) return;
          try {
            await api(`/api/auth/tokens/${b.dataset.revoke}`, { method: 'DELETE' });
            loadTokens();
          } catch (err) {
            toast(err.message, 'error');
          }
        })
      );
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  $('#token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/auth/tokens', { method: 'POST', body: { name: $('#token-name').value } });
      const box = $('#token-new');
      box.className = 'form-note';
      box.innerHTML =
        `Copy this now — it is shown once and never again:<br><code>${esc(data.token)}</code>` +
        `<br><br><strong>Gemini Spark</strong> needs no token at all — just paste ` +
        `<code>${esc(location.origin)}/mcp</code> into Connected Apps and approve.` +
        `<br><strong>Connect by URL with a token</strong> (Gemini CLI and similar): point the client at ` +
        `<code>${esc(location.origin)}/mcp</code> with the header ` +
        `<code>Authorization: Bearer &lt;the token above&gt;</code>.` +
        `<br><strong>Or locally</strong> (Claude Desktop): run <code>mcp/server.js</code> with ` +
        `<code>PRODIGY_MAIL_URL=${esc(location.origin)}</code> and <code>PRODIGY_MAIL_TOKEN</code>.`;
      box.classList.remove('hidden');
      $('#token-name').value = '';
      loadTokens();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ───────────────────────── Administration ─────────────────────────
  let adminUsers = [];

  async function loadAdmin() {
    if (state.user.role !== 'admin') return;
    try {
      const [{ users }, { mailboxes }] = await Promise.all([
        api('/api/admin/users'),
        api('/api/admin/mailboxes'),
      ]);
      adminUsers = users;
      renderUsersTable(users);
      renderMailboxesTable(mailboxes);
      renderUserPicker(users.filter((u) => u.is_active));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderUserPicker(users, selected = []) {
    const chosen = new Set(selected.map(Number));
    $('#m-users').innerHTML = users.length
      ? users
          .map(
            (u) => `<label>
              <input type="checkbox" name="mailboxUser" value="${u.id}" ${chosen.has(u.id) ? 'checked' : ''} />
              <span>${esc(u.name)}<br><span class="up-mail">${esc(u.login_email)}</span></span>
              ${u.role === 'admin' ? '<span class="pill up-role">Admin</span>' : ''}
            </label>`
          )
          .join('')
      : '<div class="up-empty">Create a user first, then assign an email to them.</div>';
  }

  function selectedUserIds() {
    return $$('#m-users input[name=mailboxUser]:checked').map((el) => Number(el.value));
  }

  function renderUsersTable(users) {
    $('#users-table tbody').innerHTML = users
      .map(
        (u) => `<tr>
          <td><strong>${esc(u.name)}</strong>${u.designation ? `<br><span class="muted">${esc(u.designation)}</span>` : ''}</td>
          <td class="mono">${esc(u.login_email)}</td>
          <td><span class="pill ${u.role === 'admin' ? '' : 'off'}">${u.role === 'admin' ? 'Admin' : 'User'}</span></td>
          <td>${u.mailbox_count}</td>
          <td><span class="pill ${u.is_active ? 'ok' : 'bad'}">${u.is_active ? 'Active' : 'Disabled'}</span></td>
          <td><div class="actions">
            <button class="btn btn-ghost" data-act="reset" data-id="${u.id}">Reset password</button>
            <button class="btn btn-ghost" data-act="toggle" data-id="${u.id}">${u.is_active ? 'Disable' : 'Enable'}</button>
            <button class="btn btn-ghost danger" data-act="delete" data-id="${u.id}">Delete</button>
          </div></td>
        </tr>`
      )
      .join('');

    $$('#users-table [data-act]').forEach((btn) =>
      btn.addEventListener('click', () => userAction(btn.dataset.act, Number(btn.dataset.id)))
    );
  }

  async function userAction(action, id) {
    const user = adminUsers.find((u) => u.id === id);
    try {
      if (action === 'reset') {
        if (!confirm(`Reset the password for ${user.name}? They will be signed out everywhere.`)) return;
        const { temporaryPassword } = await api(`/api/admin/users/${id}/password`, { method: 'POST', body: {} });
        showAdminNote('#user-form-msg', `New password for <strong>${esc(user.name)}</strong>: <code>${esc(temporaryPassword)}</code> — share it securely; they must change it at first sign-in.`);
      } else if (action === 'toggle') {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { isActive: !user.is_active } });
      } else if (action === 'delete') {
        if (!confirm(`Delete ${user.name}? Their mailboxes and signature are removed too.`)) return;
        await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      }
      loadAdmin();
    } catch (err) {
      showAdminNote('#user-form-msg', esc(err.message), true);
    }
  }

  function showAdminNote(selector, html, isError = false) {
    const el = $(selector);
    el.innerHTML = html;
    el.className = `form-note${isError ? ' error' : ''}`;
    el.classList.remove('hidden');
  }

  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/admin/users', {
        method: 'POST',
        body: {
          name: $('#u-name').value,
          loginEmail: $('#u-email').value,
          designation: $('#u-designation').value,
          role: $('#u-role').value,
          password: $('#u-password').value,
        },
      });
      showAdminNote(
        '#user-form-msg',
        `User created. Sign-in password: <code>${esc(data.temporaryPassword)}</code> — share it securely; they must change it at first sign-in.`
      );
      e.target.reset();
      loadAdmin();
    } catch (err) {
      showAdminNote('#user-form-msg', esc(err.message), true);
    }
  });

  function renderMailboxesTable(rows) {
    $('#mailboxes-table tbody').innerHTML = rows.length
      ? rows
          .map(
            (m) => `<tr>
              <td class="mono"><strong>${esc(m.address)}</strong>${
                (m.users || []).length > 1 ? `<span class="shared-pill">Shared × ${m.users.length}</span>` : ''
              }${m.display_name ? `<br><span class="muted">${esc(m.display_name)}</span>` : ''}</td>
              <td><div class="who-list">${
                (m.users || []).length
                  ? m.users
                      .map((u) => `<span class="${u.isDefault ? 'is-default' : ''}" title="${esc(u.loginEmail)}${u.isDefault ? ' — their default sender' : ''}">${esc(u.name)}</span>`)
                      .join('')
                  : '<span class="muted">nobody yet</span>'
              }</div></td>
              <td class="mono">${esc(m.imap_host)}:${m.imap_port}</td>
              <td class="mono">${esc(m.smtp_host)}:${m.smtp_port}</td>
              <td>${m.last_error ? `<span class="pill bad" title="${esc(m.last_error)}">Error</span>` : m.last_checked_at ? `<span class="pill ok">OK</span>` : '<span class="pill off">Untested</span>'}<br><span class="muted">${esc(m.last_checked_at || '')}</span></td>
              <td><div class="actions">
                <button class="btn btn-ghost" data-mact="test" data-id="${m.id}">Test</button>
                <button class="btn btn-ghost" data-mact="edit" data-id="${m.id}">Edit</button>
                <button class="btn btn-ghost danger" data-mact="delete" data-id="${m.id}">Remove</button>
              </div></td>
            </tr>`
          )
          .join('')
      : '<tr><td colspan="6" class="muted" style="padding:20px;text-align:center">No business emails assigned yet.</td></tr>';

    window.__mailboxRows = rows;
    $$('#mailboxes-table [data-mact]').forEach((btn) =>
      btn.addEventListener('click', () => mailboxAction(btn.dataset.mact, Number(btn.dataset.id)))
    );
  }

  function mailboxFormValues() {
    return {
      id: $('#m-id').value || undefined,
      userIds: selectedUserIds(),
      address: $('#m-address').value,
      displayName: $('#m-display').value,
      sentFolder: $('#m-sent').value,
      imapHost: $('#m-imap-host').value,
      imapPort: $('#m-imap-port').value,
      imapUser: $('#m-imap-user').value,
      imapSecure: $('#m-imap-secure').value === 'true',
      imapPassword: $('#m-imap-password').value,
      smtpHost: $('#m-smtp-host').value,
      smtpPort: $('#m-smtp-port').value,
      smtpUser: $('#m-smtp-user').value,
      smtpSecure: $('#m-smtp-secure').value === 'true',
      smtpPassword: $('#m-smtp-password').value,
      isDefault: $('#m-default').checked,
    };
  }

  function resetMailboxForm() {
    $('#mailbox-form').reset();
    $$('#m-users input[name=mailboxUser]').forEach((el) => (el.checked = false));
    $('#m-id').value = '';
    $('#m-imap-port').value = '993';
    $('#m-smtp-port').value = '465';
    $('#mailbox-form-title').textContent = 'Assign a business email';
    $('#m-pass-req').classList.remove('hidden');
    $('#mailbox-form-msg').classList.add('hidden');
  }

  $('#m-reset').addEventListener('click', resetMailboxForm);

  async function mailboxAction(action, id) {
    const row = (window.__mailboxRows || []).find((m) => m.id === id);
    try {
      if (action === 'edit') {
        $('#m-id').value = row.id;
        const holders = (row.users || []).map((u) => u.userId);
        $$('#m-users input[name=mailboxUser]').forEach((el) => {
          el.checked = holders.includes(Number(el.value));
        });
        $('#m-address').value = row.address;
        $('#m-display').value = row.display_name || '';
        $('#m-sent').value = row.sent_folder || '';
        $('#m-imap-host').value = row.imap_host;
        $('#m-imap-port').value = row.imap_port;
        $('#m-imap-user').value = row.imap_user;
        $('#m-imap-secure').value = String(!!row.imap_secure);
        $('#m-smtp-host').value = row.smtp_host;
        $('#m-smtp-port').value = row.smtp_port;
        $('#m-smtp-user').value = row.smtp_user;
        $('#m-smtp-secure').value = String(!!row.smtp_secure);
        $('#m-default').checked = !!row.is_default;
        $('#m-imap-password').value = '';
        $('#m-smtp-password').value = '';
        $('#mailbox-form-title').textContent = `Edit ${row.address}`;
        $('#m-pass-req').classList.add('hidden');
        $('#mailbox-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (action === 'test') {
        showAdminNote('#mailbox-form-msg', 'Testing connection…');
        const result = await api('/api/admin/mailboxes/test', { method: 'POST', body: { id } });
        reportTest(result);
        loadAdmin();
      } else if (action === 'delete') {
        if (!confirm(`Remove ${row.address}? The user will no longer be able to send or read from it.`)) return;
        await api(`/api/admin/mailboxes/${id}`, { method: 'DELETE' });
        loadAdmin();
      }
    } catch (err) {
      showAdminNote('#mailbox-form-msg', esc(err.message), true);
    }
  }

  function reportTest(result) {
    const ok = result.imap.ok && result.smtp.ok;
    showAdminNote(
      '#mailbox-form-msg',
      `IMAP: ${result.imap.ok ? '✅ connected' : `❌ ${esc(result.imap.error)}`}<br>SMTP: ${
        result.smtp.ok ? '✅ connected' : `❌ ${esc(result.smtp.error)}`
      }`,
      !ok
    );
  }

  $('#m-test').addEventListener('click', async () => {
    try {
      showAdminNote('#mailbox-form-msg', 'Testing connection…');
      const values = mailboxFormValues();
      const body = values.id && !values.imapPassword ? { id: values.id } : values;
      reportTest(await api('/api/admin/mailboxes/test', { method: 'POST', body }));
    } catch (err) {
      showAdminNote('#mailbox-form-msg', esc(err.message), true);
    }
  });

  $('#mailbox-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = mailboxFormValues();
    try {
      if (values.id) {
        await api(`/api/admin/mailboxes/${values.id}`, { method: 'PATCH', body: values });
        showAdminNote('#mailbox-form-msg', 'Mailbox updated.');
      } else {
        await api('/api/admin/mailboxes', { method: 'POST', body: values });
        showAdminNote('#mailbox-form-msg', 'Business email assigned.');
      }
      resetMailboxForm();
      loadAdmin();
      // The signed-in admin may have just assigned a mailbox to themselves.
      const me = await api('/api/auth/me');
      state.mailboxes = me.mailboxes;
      if (!state.mailboxId && state.mailboxes.length) state.mailboxId = state.mailboxes[0].id;
      renderMailboxSelect();
    } catch (err) {
      showAdminNote('#mailbox-form-msg', esc(err.message), true);
    }
  });

  $$('[data-tab]').forEach((tab) =>
    tab.addEventListener('click', async () => {
      $$('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
      if (tab.dataset.tab === 'log') {
        try {
          const { entries } = await api('/api/admin/sent-log');
          $('#log-table tbody').innerHTML = entries.length
            ? entries
                .map(
                  (l) => `<tr>
                    <td class="muted">${esc(new Date(l.created_at + 'Z').toLocaleString())}</td>
                    <td>${esc(l.user_name)}</td>
                    <td class="mono">${esc(l.to_addr)}</td>
                    <td>${esc(l.subject || '(no subject)')}</td>
                    <td>${l.status === 'sent' ? '<span class="pill ok">Sent</span>' : `<span class="pill bad" title="${esc(l.error)}">Failed</span>`}</td>
                  </tr>`
                )
                .join('')
            : '<tr><td colspan="5" class="muted" style="padding:20px;text-align:center">Nothing sent yet.</td></tr>';
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    })
  );

  // Poll the open folder for new mail while the tab is visible.
  setInterval(() => {
    if (state.view === 'mail' && state.mailboxId && state.page === 1 && !document.hidden) {
      loadMessages();
    }
  }, 120000);

  boot();
})();
