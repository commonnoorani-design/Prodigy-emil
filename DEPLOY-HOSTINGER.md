# Deploying to Hostinger

This app is a Node.js server, not static PHP files. It needs a Node runtime that
stays running — a **Hostinger VPS** (or any plan whose hPanel has a **Node.js**
section). Hostinger's plain shared web hosting only runs PHP and cannot host it.

Two routes below. Pick **A** if your hPanel has a Node.js app manager, **B** if
you have a VPS with SSH.

---

## Before you start

Nothing. There is no key to generate and no URL to work out — the app mints its
own encryption key on first start (kept in `data/secret.key`) and reads its
public address from the request. Copy `.env.example` to `.env`, set the
administrator email and password, and that is the whole configuration.

Back up `data/secret.key` once it exists. Lose it and every saved mailbox
password has to be entered again.

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

4. **Set the administrator login.** Edit `.env` in the File Manager (or add the
   same names as environment variables in the Node.js panel):

   ```
   ADMIN_EMAIL    = admin@prodigyeducations.com
   ADMIN_PASSWORD = <the password you want>
   ```

   This is a sign-in username, not a mailbox — it does not have to exist on
   your mail server. It is only read on the very first start, while the user
   table is still empty. (`.env.example` lists every other option, including
   the branding fields.)

5. **Start**, then open the URL and sign in with those credentials.

6. **Once HTTPS works on the domain**, set `SECURE_COOKIES=true` and restart.
   Do it in that order — with it on, the browser refuses to send the sign-in
   cookie over plain HTTP, and sign-in silently bounces you back to the
   login screen.

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
nano .env          # set ADMIN_EMAIL and ADMIN_PASSWORD
```

Keep it running with pm2:

```bash
npm install -g pm2
pm2 start server/index.js --name prodigy-mail
pm2 logs prodigy-mail --lines 30    # confirms it started; also prints a
                                    # generated admin password if you left
                                    # ADMIN_PASSWORD blank
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

With HTTPS working, set `SECURE_COOKIES=true` in `.env` and `pm2 restart
prodigy-mail`.

---

## "Request failed (404)" / "The application server is not answering"

The login page appears and looks right, but signing in fails. That means the
web server is handing out the files in `public/` and nothing is running the
Node app behind them. Static files exist on disk, `/api/...` does not, so the
web server returns its own 404.

**Confirm it in one step.** Open this in a browser:

```
https://your-domain.com/api/health
```

| What you see | What it means |
|---|---|
| `{"ok":true,"brand":"Prodigy Educations"}` | Node is serving. The problem is elsewhere — check the app log. |
| A 404 page | Nothing but static files. The Node app is not running, or the domain is not pointed at it. |
| 502 / 503 | The app is proxied but crashed or never started. Check the app log. |

**Fixing it**

1. Is the app actually started? hPanel → **Node.js** → the application should
   read *Running*, not *Stopped*. Over SSH: `pm2 status`.
2. Is the startup file `server/index.js`? Not `index.js`, not `app.js`.
3. Was **Run NPM Install** pressed? Without `node_modules` the app exits
   immediately on start; the log will say `Cannot find module 'express'`.
4. Does the domain point at the app rather than at a folder? If the document
   root is set to the extracted folder (or to its `public/` subfolder), the
   web server answers directly and the Node app is never consulted. On a VPS
   this is the nginx `proxy_pass` block above; in hPanel it is the
   *Application URL* field.
5. **Does your plan run Node at all?** If hPanel has no **Node.js** section,
   the plan is PHP-only and cannot host this app however the files are
   arranged — that needs a VPS. There is no workaround: the app has to hold
   long-lived IMAP and SMTP connections, which a PHP-only host cannot do.

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
  signatures), the uploaded profile pictures, and `secret.key` — the key that
  decrypts the stored mailbox passwords. Nothing else is stateful.
- **Updating.** Upload the new files over the old ones, keep `data/` and `.env`
  untouched, run `npm install`, then restart the app.
- **Locked out?** `node scripts/seed-admin.js admin@prodigyeducations.com "Prodigy Administrator"`
  prints a fresh administrator password.
