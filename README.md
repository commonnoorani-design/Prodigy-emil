<div align="center">
  <img src="public/assets/logo-web.png" width="140" alt="Prodigy Educations" />
  <h1>Prodigy Educations — Business Mail</h1>
  <p>A branded webmail for the team: read and reply to your business inbox in the browser, and send messages that always carry the company header, your personal signature and the Prodigy Educations footer.</p>
</div>

---

## What it does

- **Read your business inbox in the browser.** Connects to your hosting's IMAP server — folders, unread counts, search, attachments, flag, delete.
- **Reply, reply-all and forward** with correct threading headers, so conversations stay intact in the recipient's mail client.
- **Every outgoing message is wrapped in the company template** — logo header linking to the website, the message body, the sender's signature, and the Prodigy Educations footer.
- **One signature layout for everyone**, filled in per person: profile picture, name, designation, email, phone (with how the number may be used), and a meeting link.
- **Multiple users with one or more administrators.** Only an administrator assigns business email addresses.
- **A copy of everything sent is filed in the account's Sent folder** over IMAP, plus an in-app audit log.
- **Print a message, or save it as a PNG** — both on company letterhead, with who it was between and when.

## The message template

```
┌──────────────────────────────────────────────┐
│  [ LOGO → prodigyeducations.com ]  website   │  header
├──────────────────────────────────────────────┤
│  The message you typed                       │  body
│                                              │
│  ──────────                                  │
│  [DP]  Name                                  │  signature
│        DESIGNATION                           │   (per user,
│        Prodigy Educations                    │    same layout
│        Email    you@prodigyeducations.com    │    for everyone)
│        Phone    +92 … · Call, SMS & WhatsApp │
│        Meeting  Book a time with me ›        │
├──────────────────────────────────────────────┤
│  Prodigy Educations                          │  footer
│  Support    support@prodigyeducations.com    │   (fixed for
│  WhatsApp   +92 330 9829829 · WhatsApp only  │    everyone)
│  Website    prodigyeducations.com            │
│  Confidentiality notice                      │
└──────────────────────────────────────────────┘
```

Signature fields are all optional except the name — leave a field blank and its row simply disappears. The phone row states how the number may be used: **Call, SMS & WhatsApp**, **Call & SMS only**, or **WhatsApp only**. The logo and profile picture are embedded in the message itself, so they still render when a mail client blocks remote images.

## Running it

```bash
git clone https://github.com/commonnoorani-design/Prodigy-emil.git
cd Prodigy-emil
npm install

cp .env.example .env
# set ADMIN_EMAIL and ADMIN_PASSWORD, then:
npm start
```

Open the app and sign in with those credentials. `ADMIN_EMAIL` is a sign-in username, not a mailbox — it does not have to exist on your mail server. Leave `ADMIN_PASSWORD` blank instead and the first start generates one and prints it to the console.

Nothing else needs configuring. The key that encrypts stored mailbox passwords is generated on first start and kept in `data/secret.key`; back that file up, because losing it means re-entering every mailbox password.

## Connecting your hosting's mail servers

Sign in as an administrator → **Administration → Business emails → Assign a business email**.

| Field | Typical value (cPanel / DirectAdmin / Plesk) |
|---|---|
| Business email | `name@prodigyeducations.com` |
| IMAP host | `mail.prodigyeducations.com` |
| IMAP port | `993` with SSL/TLS (or `143` for STARTTLS) |
| SMTP host | `mail.prodigyeducations.com` |
| SMTP port | `465` with SSL/TLS (or `587` for STARTTLS) |
| Username | usually the full email address |
| Password | the mailbox password from your hosting panel |

Press **Test connection** before saving — it reports IMAP and SMTP separately, so a failure points straight at the setting that is wrong. Leave **Sent folder** blank and the app finds it automatically; set it explicitly (e.g. `INBOX.Sent`) if your host uses an unusual name.

If your host presents a self-signed certificate, set `IMAP_ALLOW_SELF_SIGNED=1` / `SMTP_ALLOW_SELF_SIGNED=1` — a workaround for a broken certificate, not something to leave on.

## Day-to-day use

**Administrator**
1. **Administration → Users** — create an account. The password is generated and shown once; share it securely. The user must change it at first sign-in.
2. **Administration → Business emails** — assign the address that user sends and receives from. Tick more than one person to share an address like `info@` or `admissions@` across a team: they all read the same inbox and send as that address, and replies filed in Sent are visible to everyone who holds it. A user can hold several addresses; each person picks their own default sender.
3. **Administration → Sent log** — every message sent through the platform, including failures.

**Everyone**
1. **My signature** — upload a photo and fill in your details. The live preview shows both the signature card and a full sample message.
2. **Mailbox** — read, search, reply, forward, attach. The template is applied on send; **Preview** shows exactly what the recipient will get.
3. **Print** and **Save as PNG**, on an open message, lay it out on company letterhead — subject, sender, recipients, date, attachment names, then the message. Printing uses the browser's own dialogue, so "Save as PDF" is there too. Pictures the sender hosted elsewhere cannot travel into a PNG; the app says so when it drops one, and printing keeps them.

## Connecting an AI assistant

The app ships an MCP server, so Claude (or any MCP client) can read your inbox,
draft replies and send branded mail as you: [mcp/README.md](mcp/README.md).

Create a token under **your initials → Change password → AI access tokens**, then
either:

- **paste the link** — `https://email.prodigyeducations.com/mcp`. Clients that
  sign in for themselves, such as Gemini Spark, register with the server and
  send you to a consent page; nothing to create or install.
- **connect by URL with a token** — the same address with an
  `Authorization: Bearer pem_…` header, which is what Gemini CLI expects.
- **run it locally** — point a stdio client such as Claude Desktop at
  `mcp/server.js` with `PRODIGY_MAIL_URL` and `PRODIGY_MAIL_TOKEN`.

Either way the assistant gets the same mail access you have — but never
administration, and never your mailbox password. Revoke a token from the same
screen at any time.

## Configuration

Everything lives in `.env` (see `.env.example`). Branding — company name, tagline, website, support address, WhatsApp number, established year, optional postal address, and the brand colours — is read from there, so the header, footer and signatures update everywhere at once.

## Deploying

**Hostinger:** step-by-step instructions are in [DEPLOY-HOSTINGER.md](DEPLOY-HOSTINGER.md).

Anywhere else: run it behind a TLS-terminating reverse proxy with `TRUST_PROXY=true`, and set `SECURE_COOKIES=true` **once HTTPS is actually working** — until then the browser will not send the sign-in cookie and login appears to fail.

```nginx
server {
  server_name mail.prodigyeducations.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 25m;
  }
}
```

Keep it running with systemd, pm2 or Docker. Back up the `data/` directory — it holds the SQLite database, the uploaded profile pictures and the encryption key.

## Security notes

- Mailbox passwords are encrypted with AES-256-GCM under a per-install key (`SECRET_KEY`, or `data/secret.key` when that is unset); they are never returned to the browser.
- Sign-in passwords are bcrypt hashes. Sign-in is rate limited.
- Sessions are httpOnly cookies with a server-side record, revoked on password change.
- Incoming mail is sanitised server-side and rendered in a sandboxed iframe with scripts disabled.
- Anything typed into the composer is sanitised again before it is sent.
- Profile pictures are only served to signed-in users.

## Project layout

```
server/
  index.js            Express app, static hosting, shutdown
  config.js           environment + branding
  db.js               SQLite schema and first-run bootstrap
  crypto.js           AES-256-GCM for stored mailbox passwords
  auth.js             sessions, password hashing, route guards
  templates/index.js  header, signature and footer HTML  ← the email template
  mail/imap.js        pooled IMAP: folders, paging, search, flags, append
  mail/smtp.js        MIME assembly and delivery
  mail/mailboxes.js   mailbox records and credential access
  routes/             auth, admin, signature, mail
public/               single-page client (no build step)
  print.js            printing a message and saving it as an image
mcp/server.js         MCP server, so an AI assistant can use your mailbox
scripts/seed-admin.js recover or add an administrator from the CLI
```

## Recovering administrator access

```bash
node scripts/seed-admin.js admin@prodigyeducations.com "Prodigy Administrator"
```

Prints a new password and requires a change at next sign-in.
