# Deploying to Hostinger

Hostinger runs Node.js apps on **Business Web Hosting** and the **Cloud** plans
(Startup, Professional, Enterprise). It is not a VPS-only feature — those plans
have a *Deploy Web App* flow that builds and runs the app for you.

**Premium Web Hosting does not include it.** If that is your plan, upgrading to
Business is the cheapest route; nothing else about your existing websites
changes.

Route **A** below is the shared-hosting flow. Route **B** is a VPS, for when you
want full control.

---

## Route A — Business / Cloud plan, via *Deploy Web App*

This is not under "Node.js" in the sidebar, which is why it is easy to miss.

1. **hPanel → Websites → Add Website → Deploy Web App.**

2. **Choose how to supply the code.**
   - *GitHub* — connect `commonnoorani-design/Prodigy-emil` and pick the branch.
     Every push redeploys.
   - *Upload* — upload `prodigy-mail.zip`. Hostinger keeps the ZIP for later
     redeployments.

3. **Framework:** the app is a plain Express server with no build step, so pick
   **Other**.

   | Setting | Value |
   |---|---|
   | Framework | Other |
   | Entry file | `server/index.js` |
   | Output directory | leave empty — there is nothing to build |
   | Node.js version | 20 or newer |

4. **Environment variables** — set these in the panel:

   ```
   ADMIN_EMAIL    admin@prodigyeducations.com
   ADMIN_PASSWORD <the password you want>
   TRUST_PROXY    true
   SECURE_COOKIES true
   DATA_DIR       /home/<your-username>/prodigy-data
   UPLOAD_DIR     /home/<your-username>/prodigy-data/uploads
   DB_FILE        /home/<your-username>/prodigy-data/prodigy-mail.db
   ```

   Those last three matter. Deployed builds live under
   `/home/<username>/domains/<domain>/nodejs`, which is replaced on every
   redeploy. Pointing the data directory outside it keeps the database, the
   profile pictures and the encryption key across deployments. Without this you
   would be back to a blank install after each push.

   Do not set `PORT` — Hostinger assigns one and the app already reads it.

5. **Deploy.** npm install runs automatically; you do not need SSH.

6. **Open the app's URL and sign in** with the email and password from step 4.

7. Confirm it is really running: `https://<your-app-url>/api/health` should
   return `{"ok":true,"brand":"Prodigy Educations"}`.

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

## "Incorrect email or password" on a fresh deploy

This means the app is running correctly — that message comes from the app
itself, not the web server. It only means the administrator account does not
have the password you are typing.

It happens when the app is deployed from GitHub: `.env` is deliberately not in
the repository, so `ADMIN_PASSWORD` was never supplied. The first start
generated one instead and printed it to the deployment log.

**Fix it from the panel, no shell needed.** Set these environment variables and
redeploy:

```
ADMIN_EMAIL     admin@prodigyeducations.com
ADMIN_PASSWORD  <the password you want>
```

On the next start the app applies that password to the administrator account —
creating it if missing, resetting it if present — and says so in the log:

```
 Administrator password reset from ADMIN_PASSWORD
```

Restarting again with the same value changes nothing, and a password you later
change inside the app is left alone. Changing the variable is what triggers a
reset, so it doubles as the recovery route if you are ever locked out.

---

## Sign-in is accepted, then you are back on the sign-in page

The password went through — an incorrect one says so — and the very next
request arrived signed out. The page now names which half broke, and the two
have different fixes.

**"Your browser did not keep the sign-in cookie."** Nothing reached the server
to reject. Something in the browser dropped it:

- a private/incognito window, a cookie blocker, or an in-app browser (opening
  the link from inside WhatsApp is the usual one) — open it in the browser
  itself;
- the site opened over `http://` — always use `https://`, the cookie is marked
  Secure;
- a device clock that is hours fast. (The cookie is timed with `Max-Age`, which
  is immune to this, so it only affects builds older than this one.)

**"The server did not recognise the session it had just created."** The session
was written and then lost, which means the database is not on permanent
storage. Hostinger replaces the application folder on every deploy, so the data
has to live outside it:

```
DATA_DIR  /home/<your-username>/prodigy-data
```

That one setting is enough — the database and the uploaded photos both live
inside it unless `DB_FILE` or `UPLOAD_DIR` say otherwise.

**Check the app itself** at `/api/health`:

```json
{ "build": "…", "instance": "5f3a1c22", "uptimeSeconds": 4210, "sessions": 3, "dbFile": "/home/…/prodigy-data/prodigy-mail.db" }
```

- `uptimeSeconds` back near zero every time you reload → the app is restarting
  between requests; the deployment log says why.
- `instance` changing back and forth between reloads → more than one copy is
  running behind the CDN, and they do not share sessions.
- `sessions` not going up after you sign in → the write is not surviving; check
  `dbFile` points inside `DATA_DIR`.

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
5. **Was the app deployed through *Deploy Web App* at all?** Uploading the ZIP
   into `public_html` with the File Manager does not run it — the web server
   just serves the files, and every `/api/...` request 404s. The app has to be
   created through **hPanel → Websites → Add Website → Deploy Web App**.
6. **Is your plan Business or Cloud?** Premium Web Hosting has no Node.js
   support; upgrading to Business adds it.

---

## If your plan cannot run Node

Only Premium Web Hosting lacks Node.js support. Upgrading to Business is the
simplest fix. If you would rather host it elsewhere, these also work.

**1. A container host, straight from GitHub.** The repository ships a
`Dockerfile` and a `render.yaml`. On Render: *New → Blueprint → pick the repo →
set `ADMIN_PASSWORD` → deploy*. You get HTTPS and a URL immediately, and can
point `mail.prodigyeducations.com` at it with a CNAME. Fly.io and Railway read
the same `Dockerfile`. Your existing Hostinger plan keeps serving the main
website, untouched.

**2. A Hostinger VPS.** Same billing account, full control. Follow *Route B*
above. This is the option that keeps everything under one provider.

**3. Any box with Docker.**

```bash
docker build -t prodigy-mail .
docker run -d --name prodigy-mail -p 3000:3000 \
  -v prodigy-data:/app/data \
  -e ADMIN_EMAIL=admin@prodigyeducations.com \
  -e ADMIN_PASSWORD='choose-a-password' \
  prodigy-mail
```

Whichever you pick, the `/app/data` volume is the thing to keep — database,
profile pictures and encryption key all live there.

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
