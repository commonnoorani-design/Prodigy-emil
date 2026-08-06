# Deploying to Hostinger

This app is a Node.js server, not static PHP files. It needs a Node runtime that
stays running — a **Hostinger VPS** (or any plan whose hPanel has a **Node.js**
section). Hostinger's plain shared web hosting only runs PHP and cannot host it.

Two routes below. Pick **A** if your hPanel has a Node.js app manager, **B** if
you have a VPS with SSH.

---

## Before you start — the one required setting

Generate the key that encrypts stored mailbox passwords:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep the output. It goes into `SECRET_KEY`. **Back it up** — change it later and
every saved mailbox password becomes unreadable and has to be re-entered.

---

## Route A — hPanel Node.js app manager

1. **Upload.** hPanel → **Files → File Manager**, go to your app folder, upload
   `prodigy-mail.zip` and extract it there. Do *not* put it in `public_html` if
   that folder is served as static files.

2. **Create the app.** hPanel → **Node.js** → *Create application*:

   | Setting | Value |
   |---|---|
   | Node.js version | 20 or newer |
   | Application root | the folder you extracted into |
   | Application startup file | `server/index.js` |
   | Application URL | e.g. `mail.prodigyeducations.com` |

3. **Install dependencies.** Press **Run NPM Install** in that same panel. This
   step matters: the app uses `better-sqlite3`, which compiles a native binary
   for the server it runs on. The zip deliberately ships without
   `node_modules` — a copy built on another machine will not load.

4. **Environment variables.** Still in the Node.js panel, add:

   ```
   SECRET_KEY      = <the key you generated>
   APP_URL         = https://mail.prodigyeducations.com
   SECURE_COOKIES  = true
   TRUST_PROXY     = true
   ADMIN_EMAIL     = admin@prodigyeducations.com
   NODE_ENV        = production
   ```

   (`.env.example` lists every option, including the branding fields.)

5. **Start**, then open the URL. The first start creates the administrator
   account — its password is printed to the application log, visible in the
   Node.js panel. Sign in and change it straight away.

---

## Route B — VPS with SSH

```bash
ssh root@your-vps-ip

# Node 20+ if it isn't there already
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs build-essential

mkdir -p /var/www/prodigy-mail && cd /var/www/prodigy-mail
# upload prodigy-mail.zip here (scp, or the hPanel file manager)
unzip prodigy-mail.zip
npm install --omit=dev

cp .env.example .env
nano .env          # set SECRET_KEY, APP_URL, SECURE_COOKIES=true, TRUST_PROXY=true
```

Keep it running with pm2:

```bash
npm install -g pm2
pm2 start server/index.js --name prodigy-mail
pm2 logs prodigy-mail --lines 30    # the first-run admin password is in here
pm2 save && pm2 startup
```

Put nginx and a certificate in front of it:

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

```bash
apt-get install -y nginx certbot python3-certbot-nginx
certbot --nginx -d mail.prodigyeducations.com
```

---

## Connecting your Hostinger business emails

Sign in as the administrator → **Administration → Business emails → Assign a
business email**. For mailboxes hosted on Hostinger:

| Field | Value |
|---|---|
| Business email | `name@prodigyeducations.com` |
| IMAP host | `imap.hostinger.com` |
| IMAP port | `993`, SSL/TLS |
| SMTP host | `smtp.hostinger.com` |
| SMTP port | `465`, SSL/TLS |
| Username | the full email address |
| Password | the mailbox password from hPanel → Emails |

If your domain's mail is elsewhere, use whatever host your provider lists —
often `mail.prodigyeducations.com` on the same ports.

Press **Test connection** before saving. It reports IMAP and SMTP separately, so
a failure points straight at the setting that is wrong.

> If sending fails with a connection timeout, check that outbound port 465 is
> open on the VPS firewall — some providers block it by default.

---

## After it is live

- **Back up `data/`.** It holds the SQLite database (users, mailbox settings,
  signatures) and the uploaded profile pictures. Nothing else is stateful.
- **Updating.** Upload the new files over the old ones, keep `data/` and `.env`
  untouched, run `npm install`, then restart the app.
- **Locked out?** `node scripts/seed-admin.js admin@prodigyeducations.com "Prodigy Administrator"`
  prints a fresh administrator password.
