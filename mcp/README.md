# Prodigy Mail MCP server

Connects an AI assistant to your Prodigy Educations mailbox, so it can read the
inbox, draft, and send branded mail on your behalf.

It never holds your mail password. It talks to your running instance over the
same HTTP API the website uses, with a personal access token that you can
revoke at any time.

---

## Gemini Spark — just paste the link

Spark takes a URL and handles sign-in itself, so there is no token to create
and nothing to install.

1. Go to <https://gemini.google.com> → **Settings & help → Connected Apps**.
2. Under *Custom apps for Spark*, choose **Add a custom app**.
3. Paste:

   ```
   https://email.prodigyeducations.com/mcp
   ```

4. Follow the prompts. A Prodigy Educations page appears asking you to sign in
   and approve; do that, and Spark comes back connected.

Leave the *Advanced features* credential boxes empty — the server supports
Dynamic Client Registration, so Spark registers itself.

The connection then shows up in the app under **Change password → AI access
tokens** as "Gemini Spark (connected)". Revoking it there disconnects Spark
immediately.

Custom Spark apps need a personal Google account, not a Workspace one, and can
only be added from the Gemini website — after which they work in the mobile app
too.

> Google does not vet custom MCP servers. This one is yours, and it can read and
> send your business mail, so only connect it from an account you control.

---

## 1. Get a token (for clients that ask for one)

Sign in at <https://email.prodigyeducations.com> → your initials, top right →
**Change password** → **AI access tokens** → name it, **Create token**.

The token is shown **once**. Copy it.

A token acts as you for mail and your signature. It is deliberately refused by
the administration routes, so a leaked token cannot create users or reassign
mailboxes.

## 2a. Connect by URL — no install (Gemini CLI, and anything else that takes an MCP link)

The app hosts the MCP endpoint itself:

```
https://email.prodigyeducations.com/mcp
```

**Gemini CLI** — `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "prodigy-mail": {
      "httpUrl": "https://email.prodigyeducations.com/mcp",
      "headers": { "Authorization": "Bearer pem_your_token_here" },
      "timeout": 30000
    }
  }
}
```

Or from a terminal:

```bash
gemini mcp add --transport http prodigy-mail https://email.prodigyeducations.com/mcp \
  -H "Authorization: Bearer pem_your_token_here"
```

Start `gemini` and run `/mcp` to see the tools listed.

The endpoint speaks Streamable HTTP and is stateless, so any client that
accepts an MCP URL plus an `Authorization` header will work the same way. It
refuses anything without a valid token, and answers in JSON-RPC so the client
can show you why.

## 2b. Install locally instead

```bash
git clone https://github.com/commonnoorani-design/Prodigy-emil.git
cd Prodigy-emil/mcp
npm install
```

Use the local route when your assistant only speaks stdio — Claude Desktop, for
example.

## 3. Point a stdio assistant at it

**Claude Desktop** — `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "prodigy-mail": {
      "command": "node",
      "args": ["/absolute/path/to/Prodigy-emil/mcp/server.js"],
      "env": {
        "PRODIGY_MAIL_URL": "https://email.prodigyeducations.com",
        "PRODIGY_MAIL_TOKEN": "pem_your_token_here"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the connectors icon.

**Claude Code**

```bash
claude mcp add prodigy-mail \
  --env PRODIGY_MAIL_URL=https://email.prodigyeducations.com \
  --env PRODIGY_MAIL_TOKEN=pem_your_token_here \
  -- node /absolute/path/to/Prodigy-emil/mcp/server.js
```

Cursor, Windsurf, Zed and anything else that speaks MCP over stdio take the
same command / args / env.

---

## What the assistant can do

| Tool | |
|---|---|
| `list_mailboxes` | which addresses you can use, including shared ones |
| `list_folders` | folders with unread counts |
| `list_messages` | a folder, newest first |
| `search_messages` | find by sender, recipient, subject or body |
| `read_message` | the full text of one message |
| `get_signature` | your signature card |
| `preview_message` | render a draft exactly as it would be sent — **sends nothing** |
| `send_message` | send a new message |
| `reply_to_message` | reply, threaded and quoting the original |
| `set_message_flag` | mark read/unread, flag/unflag |
| `list_sent` | what you have sent through the platform |

The company header, your signature and the Prodigy Educations footer are added
by the server on send — the assistant writes only the body.

Reading tools are marked read-only, so a well-behaved client will not prompt
for them. `send_message` and `reply_to_message` deliver real mail to real
people; your client will ask before running them, and it is worth reading the
recipient and wording each time.

## Try it

> Summarise the unread mail in my inbox.

> Draft a reply to Sara about the fee structure — show me a preview before sending.

## Which connection styles the address accepts

`https://email.prodigyeducations.com/mcp` answers to both versions of the
protocol, so a client picks whichever it speaks:

| The client does | What happens |
|---|---|
| `POST` JSON-RPC (Streamable HTTP, 2025-03-26 and later) | answered per request; no session to keep |
| `GET` with `Accept: text/event-stream` (HTTP+SSE, 2024-11-05) | a stream opens and replies are posted back to `/mcp/messages` |

Both need `Authorization: Bearer …` — a personal token, or one the client
obtained for itself through the sign-in page. Cross-origin requests are allowed,
so a client that runs inside a browser can reach it too.

## If it does not connect

- `curl https://email.prodigyeducations.com/api/health` should return JSON.
- A rejected token means it was revoked, or copied incompletely — make a new one.
- "Connection closed" or "unreachable" from a hosted client usually means it
  never got past the first request. Check it with the two commands below: the
  first should return a 401 carrying a `WWW-Authenticate` header, the second the
  tool list.

  ```bash
  curl -i -X POST https://email.prodigyeducations.com/mcp \
    -H 'Content-Type: application/json' -d '{}'

  curl -X POST https://email.prodigyeducations.com/mcp \
    -H "Authorization: Bearer pem_…" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
  ```
- The server needs Node 18 or newer.
