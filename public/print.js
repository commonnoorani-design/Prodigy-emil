/* Prodigy Educations Mail — printing a message, and saving it as an image.
 *
 * Both start from the same sheet: the company header, who the message was
 * between, and the message itself, laid out for paper rather than for a
 * screen. Printing hands that sheet to the browser's own print dialogue;
 * saving draws it into a canvas and hands back a PNG.
 *
 * Kept out of app.js because none of it belongs to the mailbox — it takes a
 * finished message and turns it into a document.
 */
(() => {
  'use strict';

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // A4 at 96dpi, less the print margins. The sheet is built at this width so
  // the printed page and the saved image are the same document.
  const SHEET_WIDTH = 720;

  const SHEET_CSS = `
    * { box-sizing: border-box; }
    body { margin: 0; background: #fff; }
    .sheet {
      width: ${SHEET_WIDTH}px;
      margin: 0 auto;
      padding: 26px 30px 24px;
      background: #fff;
      color: #12161c;
      font: 13px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    .sheet-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; padding: 0 0 14px; border-bottom: 3px solid #1e3a63;
    }
    .sheet-head img { height: 44px; width: auto; }
    .sheet-brand { text-align: right; font-size: 11px; color: #6b7686; line-height: 1.5; }
    .sheet-brand strong { display: block; color: #1e3a63; font-size: 13px; letter-spacing: .2px; }
    h1.sheet-subject { font-size: 19px; line-height: 1.35; margin: 20px 0 12px; color: #12161c; }
    .sheet-meta { border: 1px solid #e2e6ec; border-radius: 8px; padding: 12px 14px; margin-bottom: 20px; }
    .sheet-meta div { display: flex; gap: 10px; padding: 2px 0; }
    .sheet-meta dt { flex: 0 0 74px; color: #6b7686; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; padding-top: 2px; }
    .sheet-meta dd { margin: 0; flex: 1; word-break: break-word; }
    .sheet-body { font-size: 13px; }
    .sheet-body img { max-width: 100%; height: auto; }
    .sheet-body table { max-width: 100%; border-collapse: collapse; }
    .sheet-body a { color: #1e3a63; }
    .sheet-body pre { white-space: pre-wrap; word-wrap: break-word; font: inherit; margin: 0; }
    .sheet-body blockquote { margin: 12px 0; padding-left: 12px; border-left: 3px solid #e2e6ec; color: #4a5361; }
    .sheet-foot {
      margin-top: 26px; padding-top: 10px; border-top: 1px solid #e2e6ec;
      font-size: 10.5px; color: #6b7686; display: flex; justify-content: space-between; gap: 12px;
    }
    .sheet-note { margin-top: 10px; font-size: 10.5px; color: #6b7686; font-style: italic; }
    @page { margin: 14mm; }
    @media print {
      /* The page margin already provides the white space. */
      .sheet { width: auto; padding: 0; }
      .sheet-body { page-break-inside: auto; }
    }
  `;

  /** The printable sheet, from a message the reading pane already has. */
  function sheetHtml(doc) {
    const brand = doc.brand || {};
    const row = (label, value) =>
      value ? `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>` : '';

    const attachments = (doc.attachments || []).length
      ? row('Attached', doc.attachments.join(', '))
      : '';

    return `<div class="sheet">
      <div class="sheet-head">
        <img src="/assets/logo-web.png" alt="${esc(brand.name || 'Prodigy Educations')}" />
        <div class="sheet-brand">
          <strong>${esc(brand.name || 'Prodigy Educations')}</strong>
          ${esc(brand.websiteLabel || '')}${brand.supportEmail ? ` &middot; ${esc(brand.supportEmail)}` : ''}
        </div>
      </div>
      <h1 class="sheet-subject">${esc(doc.subject || '(no subject)')}</h1>
      <dl class="sheet-meta">
        ${row('From', doc.from)}
        ${row('To', doc.to)}
        ${row('Cc', doc.cc)}
        ${row('Date', doc.date)}
        ${attachments}
      </dl>
      <div class="sheet-body">${doc.bodyHtml || ''}</div>
      <div class="sheet-foot">
        <span>${esc(brand.name || 'Prodigy Educations')} business mail</span>
        <span>Printed ${esc(new Date().toLocaleString())}</span>
      </div>
    </div>`;
  }

  function documentHtml(doc) {
    return `<!doctype html><html><head><meta charset="utf-8" />
      <title>${esc(doc.subject || 'Message')}</title>
      <style>${SHEET_CSS}</style></head>
      <body>${sheetHtml(doc)}</body></html>`;
  }

  /** Resolve once every image in a document has either loaded or given up. */
  function imagesSettled(root) {
    const images = Array.from(root.querySelectorAll('img'));
    return Promise.all(
      images.map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
              // A dead image host must not hold the print dialogue hostage.
              setTimeout(resolve, 5000);
            })
      )
    );
  }

  // ───────────────────────── Print ─────────────────────────
  /**
   * Print through a hidden frame rather than a new window: no popup to be
   * blocked, and the page behind it is left exactly as it was.
   */
  async function print(doc) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);

    const view = frame.contentWindow;
    view.document.open();
    view.document.write(documentHtml(doc));
    view.document.close();

    await imagesSettled(view.document);

    const remove = () => frame.remove();
    view.addEventListener('afterprint', remove, { once: true });
    // Safari never fires afterprint from a frame; clear it up anyway.
    setTimeout(remove, 60000);

    view.focus();
    view.print();
  }

  // ───────────────────────── Save as PNG ─────────────────────────
  function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * An image drawn from an SVG cannot fetch anything, so every picture has to
   * be carried inside the markup. Ours already are (inline mail images arrive
   * as data URIs); anything still hosted elsewhere is fetched if it is ours to
   * fetch, and dropped if it is not — reported back so the person is told.
   */
  async function inlineImages(root) {
    let dropped = 0;
    await Promise.all(
      Array.from(root.querySelectorAll('img')).map(async (img) => {
        const src = img.getAttribute('src') || '';
        if (src.startsWith('data:')) return;
        try {
          const url = new URL(src, location.href);
          if (url.origin !== location.origin) throw new Error('remote');
          const res = await fetch(url.href, { credentials: 'same-origin' });
          if (!res.ok) throw new Error(`status ${res.status}`);
          img.setAttribute('src', await blobToDataUri(await res.blob()));
        } catch {
          img.remove();
          dropped += 1;
        }
      })
    );
    return dropped;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function fileName(subject) {
    const slug = String(subject || 'message')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'message';
    return `prodigy-mail-${slug}.png`;
  }

  async function png(doc) {
    // Lay the sheet out off-screen in this page, so the browser measures and
    // wraps it exactly as it will be drawn. Two elements, deliberately: the
    // outer one holds the off-screen position, and only the inner one is
    // copied into the image — a `left:-10000px` carried into the drawing puts
    // the whole sheet outside it, and the result is a blank page.
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;z-index:-1';
    const sheet = document.createElement('div');
    sheet.style.cssText = `width:${SHEET_WIDTH}px;background:#fff`;
    sheet.innerHTML = `<style>${SHEET_CSS}</style>${sheetHtml(doc)}`;
    host.appendChild(sheet);
    document.body.appendChild(host);

    try {
      await imagesSettled(sheet);
      const dropped = await inlineImages(sheet);
      if (dropped) {
        const note = document.createElement('p');
        note.className = 'sheet-note';
        note.textContent =
          `${dropped} image${dropped > 1 ? 's' : ''} in this message ${dropped > 1 ? 'are' : 'is'} hosted elsewhere ` +
          'and could not be included. Print the message instead to keep them.';
        const card = sheet.querySelector('.sheet');
        card.insertBefore(note, card.querySelector('.sheet-foot'));
      }

      const width = SHEET_WIDTH;
      const height = Math.ceil(sheet.getBoundingClientRect().height) + 8;

      let xml = new XMLSerializer().serializeToString(sheet);
      if (!xml.includes('xmlns=')) {
        xml = xml.replace('<div', '<div xmlns="http://www.w3.org/1999/xhtml"');
      }
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
        `<foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject></svg>`;

      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('This message could not be drawn as an image'));
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      });

      // Draw at 2× for a readable image, unless that would exceed what a
      // canvas can hold — a very long message is better small than missing.
      const scale = height * 2 > 16000 ? 1 : 2;
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);

      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not produce a PNG'))), 'image/png')
      );
      download(blob, fileName(doc.subject));
      return { dropped };
    } finally {
      host.remove();
    }
  }

  window.MailExport = { print, png };
})();
