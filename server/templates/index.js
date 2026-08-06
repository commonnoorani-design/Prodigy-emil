'use strict';

const config = require('../config');

const BRAND = config.brand;

// Content IDs used when a message is actually sent — the images travel with
// the mail so they render even when remote content is blocked.
const LOGO_CID = 'prodigy-logo@prodigyeducations.com';
const PHOTO_CID = 'prodigy-dp@prodigyeducations.com';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only http(s) and mailto/tel links survive. Anything else becomes '#'
// so a stored value can never turn into a javascript: link.
function safeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^(https?:|mailto:|tel:)/i.test(raw)) return escapeHtml(raw);
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(raw)) return escapeHtml(`https://${raw}`);
  return '';
}

function digits(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function plainPhoneLabel(phoneType) {
  switch (phoneType) {
    case 'whatsapp':
      return 'WhatsApp only';
    case 'call_sms':
      return 'Call & SMS';
    default:
      return 'Call, SMS & WhatsApp';
  }
}

/**
 * The company-wide signature card. Every user gets exactly this layout; only
 * the field values differ.
 *
 * @param {object} sig      Signature record (full_name, designation, email, phone, phone_type, meeting_link)
 * @param {object} opts     { photoSrc, mode: 'send' | 'preview' }
 */
function buildSignature(sig = {}, opts = {}) {
  const photoSrc = opts.photoSrc || '';
  const name = escapeHtml(sig.full_name || '');
  const designation = escapeHtml(sig.designation || '');
  const email = String(sig.email || '').trim();
  const phone = String(sig.phone || '').trim();
  const phoneType = sig.phone_type || 'call_sms_whatsapp';
  const meeting = safeUrl(sig.meeting_link);

  const rows = [];

  if (email) {
    rows.push(`
      <tr>
        <td style="padding:2px 8px 2px 0;font:400 12px/18px Arial,Helvetica,sans-serif;color:${BRAND.gold};white-space:nowrap;">Email</td>
        <td style="padding:2px 0;font:400 12px/18px Arial,Helvetica,sans-serif;color:${BRAND.ink};">
          <a href="mailto:${escapeHtml(email)}" style="color:${BRAND.navy};text-decoration:none;">${escapeHtml(email)}</a>
        </td>
      </tr>`);
  }

  if (phone) {
    const wa = digits(phone);
    let cell;
    if (phoneType === 'whatsapp') {
      cell = `<a href="https://wa.me/${wa}" style="color:${BRAND.navy};text-decoration:none;">${escapeHtml(phone)}</a>
              <span style="color:#7c8798;">&nbsp;·&nbsp;WhatsApp only</span>`;
    } else if (phoneType === 'call_sms') {
      cell = `<a href="tel:${wa}" style="color:${BRAND.navy};text-decoration:none;">${escapeHtml(phone)}</a>
              <span style="color:#7c8798;">&nbsp;·&nbsp;Call &amp; SMS</span>`;
    } else {
      cell = `<a href="tel:${wa}" style="color:${BRAND.navy};text-decoration:none;">${escapeHtml(phone)}</a>
              <span style="color:#7c8798;">&nbsp;·&nbsp;Call, SMS &amp;</span>
              <a href="https://wa.me/${wa}" style="color:#1f9d55;text-decoration:none;">&nbsp;WhatsApp</a>`;
    }
    rows.push(`
      <tr>
        <td style="padding:2px 8px 2px 0;font:400 12px/18px Arial,Helvetica,sans-serif;color:${BRAND.gold};white-space:nowrap;">Phone</td>
        <td style="padding:2px 0;font:400 12px/18px Arial,Helvetica,sans-serif;color:${BRAND.ink};">${cell}</td>
      </tr>`);
  }

  if (meeting) {
    rows.push(`
      <tr>
        <td style="padding:2px 8px 2px 0;font:400 12px/18px Arial,Helvetica,sans-serif;color:${BRAND.gold};white-space:nowrap;">Meeting</td>
        <td style="padding:2px 0;font:400 12px/18px Arial,Helvetica,sans-serif;color:${BRAND.ink};">
          <a href="${meeting}" style="color:${BRAND.navy};text-decoration:none;font-weight:bold;">Book a time with me &rsaquo;</a>
        </td>
      </tr>`);
  }

  const photoCell = photoSrc
    ? `<td width="76" valign="top" style="width:76px;padding-right:16px;">
         <img src="${escapeHtml(photoSrc)}" width="72" height="72" alt="${name || 'Profile photo'}"
              style="display:block;width:72px;height:72px;border-radius:36px;border:2px solid ${BRAND.gold};object-fit:cover;" />
       </td>`
    : '';

  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="pe-signature"
       style="border-collapse:collapse;margin:0;padding:0;">
  <tr>
    <td style="padding:0 0 10px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr><td style="font-size:0;line-height:0;height:1px;background:${BRAND.gold};" width="320">&nbsp;</td></tr>
      </table>
    </td>
  </tr>
  <tr>
    <td>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>
          ${photoCell}
          <td valign="top">
            <div style="font:bold 16px/20px Arial,Helvetica,sans-serif;color:${BRAND.navy};letter-spacing:.2px;">${name}</div>
            ${designation ? `<div style="font:400 12px/18px Arial,Helvetica,sans-serif;color:${BRAND.gold};text-transform:uppercase;letter-spacing:1.1px;padding-top:2px;">${designation}</div>` : ''}
            <div style="font:bold 13px/18px Arial,Helvetica,sans-serif;color:${BRAND.ink};padding:6px 0 6px 0;">${escapeHtml(BRAND.name)}</div>
            ${rows.length
              ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows.join('')}</table>`
              : ''}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();
}

/** Plain-text version of the signature, for the text/plain alternative part. */
function buildSignatureText(sig = {}) {
  const lines = [];
  if (sig.full_name) lines.push(sig.full_name);
  if (sig.designation) lines.push(sig.designation);
  lines.push(BRAND.name);
  if (sig.email) lines.push(`Email: ${sig.email}`);
  if (sig.phone) lines.push(`Phone: ${sig.phone} (${plainPhoneLabel(sig.phone_type)})`);
  if (sig.meeting_link) lines.push(`Meeting: ${sig.meeting_link}`);
  return lines.join('\n');
}

function buildHeader(logoSrc) {
  const site = safeUrl(BRAND.website) || '#';
  const logo = logoSrc
    ? `<a href="${site}" target="_blank" style="text-decoration:none;">
         <img src="${escapeHtml(logoSrc)}" width="132" alt="${escapeHtml(BRAND.name)}"
              style="display:block;border:0;width:132px;max-width:132px;height:auto;" />
       </a>`
    : `<a href="${site}" target="_blank" style="font:bold 20px/24px Arial,Helvetica,sans-serif;color:${BRAND.navy};text-decoration:none;">${escapeHtml(BRAND.name)}</a>`;

  return `
<tr>
  <td style="padding:22px 28px 16px 28px;background:#ffffff;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr>
        <td valign="middle" align="left">${logo}</td>
        <td valign="middle" align="right" style="font:400 11px/16px Arial,Helvetica,sans-serif;color:#7c8798;">
          <a href="${site}" target="_blank" style="color:${BRAND.navy};text-decoration:none;font-weight:bold;">${escapeHtml(BRAND.websiteLabel)}</a>
          <br /><span style="color:${BRAND.gold};letter-spacing:1px;">EST. ${escapeHtml(BRAND.established)}</span>
        </td>
      </tr>
    </table>
  </td>
</tr>
<tr>
  <td style="font-size:0;line-height:0;height:3px;background:${BRAND.gold};">&nbsp;</td>
</tr>`;
}

function buildFooter() {
  const site = safeUrl(BRAND.website) || '#';
  const wa = BRAND.whatsappDigits;
  return `
<tr>
  <td style="font-size:0;line-height:0;height:3px;background:${BRAND.navy};">&nbsp;</td>
</tr>
<tr>
  <td style="padding:20px 28px 24px 28px;background:#f6f7f9;">
    <div style="font:bold 13px/18px Arial,Helvetica,sans-serif;color:${BRAND.navy};">${escapeHtml(BRAND.name)}</div>
    ${BRAND.tagline ? `<div style="font:400 11px/16px Arial,Helvetica,sans-serif;color:${BRAND.gold};letter-spacing:.6px;padding-top:2px;">${escapeHtml(BRAND.tagline)}</div>` : ''}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;padding-top:8px;">
      <tr>
        <td style="padding:6px 8px 0 0;font:400 11px/16px Arial,Helvetica,sans-serif;color:#7c8798;white-space:nowrap;">Support</td>
        <td style="padding:6px 0 0 0;font:400 11px/16px Arial,Helvetica,sans-serif;">
          <a href="mailto:${escapeHtml(BRAND.supportEmail)}" style="color:${BRAND.navy};text-decoration:none;">${escapeHtml(BRAND.supportEmail)}</a>
        </td>
      </tr>
      <tr>
        <td style="padding:2px 8px 0 0;font:400 11px/16px Arial,Helvetica,sans-serif;color:#7c8798;white-space:nowrap;">WhatsApp</td>
        <td style="padding:2px 0 0 0;font:400 11px/16px Arial,Helvetica,sans-serif;">
          <a href="https://wa.me/${wa}" style="color:#1f9d55;text-decoration:none;">${escapeHtml(BRAND.whatsapp)}</a>
          <span style="color:#7c8798;">&nbsp;·&nbsp;WhatsApp only (no calls or SMS)</span>
        </td>
      </tr>
      <tr>
        <td style="padding:2px 8px 0 0;font:400 11px/16px Arial,Helvetica,sans-serif;color:#7c8798;white-space:nowrap;">Website</td>
        <td style="padding:2px 0 0 0;font:400 11px/16px Arial,Helvetica,sans-serif;">
          <a href="${site}" target="_blank" style="color:${BRAND.navy};text-decoration:none;">${escapeHtml(BRAND.websiteLabel)}</a>
        </td>
      </tr>
      ${BRAND.address
        ? `<tr>
             <td style="padding:2px 8px 0 0;font:400 11px/16px Arial,Helvetica,sans-serif;color:#7c8798;white-space:nowrap;vertical-align:top;">Address</td>
             <td style="padding:2px 0 0 0;font:400 11px/16px Arial,Helvetica,sans-serif;color:${BRAND.ink};">${escapeHtml(BRAND.address)}</td>
           </tr>`
        : ''}
    </table>
    <div style="font:400 10px/15px Arial,Helvetica,sans-serif;color:#9aa3b0;padding-top:14px;border-top:1px solid #e3e6ea;margin-top:14px;">
      This message and any attachments are confidential and intended solely for the addressee.
      If you received it in error, please notify <a href="mailto:${escapeHtml(BRAND.supportEmail)}" style="color:#7c8798;">${escapeHtml(BRAND.supportEmail)}</a> and delete it.
    </div>
  </td>
</tr>`;
}

function footerText() {
  const lines = [
    '—',
    BRAND.name,
    BRAND.tagline,
    `Support: ${BRAND.supportEmail}`,
    `WhatsApp only: ${BRAND.whatsapp}`,
    `Web: ${BRAND.website}`,
  ];
  if (BRAND.address) lines.push(BRAND.address);
  lines.push('');
  lines.push('This message and any attachments are confidential and intended solely for the addressee.');
  return lines.filter(Boolean).join('\n');
}

/**
 * Wrap a composed message body in the full Prodigy Educations shell:
 * branded header → body → signature → company footer.
 *
 * @param {object} params
 * @param {string} params.bodyHtml   Already-sanitised HTML of what the user typed.
 * @param {object} params.signature  Signature record (optional).
 * @param {string} params.logoSrc    URL or cid: reference for the logo.
 * @param {string} params.photoSrc   URL or cid: reference for the profile picture.
 * @param {string} params.quotedHtml Quoted original message when replying/forwarding.
 */
function renderEmail({ bodyHtml = '', signature = null, logoSrc = '', photoSrc = '', quotedHtml = '' }) {
  const signatureHtml = signature ? buildSignature(signature, { photoSrc }) : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(BRAND.name)}</title>
</head>
<body style="margin:0;padding:0;background:#eef0f3;-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#eef0f3;">
  <tr>
    <td align="center" style="padding:18px 10px;">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0"
             style="border-collapse:collapse;width:640px;max-width:100%;background:#ffffff;border:1px solid #e3e6ea;">
        ${buildHeader(logoSrc)}
        <tr>
          <td style="padding:26px 28px 8px 28px;font:400 14px/22px Arial,Helvetica,sans-serif;color:${BRAND.ink};">
            ${bodyHtml}
          </td>
        </tr>
        ${signatureHtml
          ? `<tr><td style="padding:14px 28px 4px 28px;">${signatureHtml}</td></tr>`
          : ''}
        ${quotedHtml
          ? `<tr><td style="padding:8px 28px 20px 28px;">
               <div style="border-left:3px solid #d8dde4;padding:4px 0 4px 14px;color:#5b6472;font:400 13px/20px Arial,Helvetica,sans-serif;">
                 ${quotedHtml}
               </div>
             </td></tr>`
          : '<tr><td style="height:14px;font-size:0;line-height:0;">&nbsp;</td></tr>'}
        ${buildFooter()}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function renderEmailText({ bodyText = '', signature = null, quotedText = '' }) {
  const parts = [bodyText.trim()];
  if (signature) parts.push('', buildSignatureText(signature));
  parts.push('', footerText());
  if (quotedText) parts.push('', quotedText);
  return parts.join('\n');
}

module.exports = {
  BRAND,
  LOGO_CID,
  PHOTO_CID,
  escapeHtml,
  safeUrl,
  buildSignature,
  buildSignatureText,
  renderEmail,
  renderEmailText,
};
