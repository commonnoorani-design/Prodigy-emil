# Prodigy Mail MCP server

Connects an AI assistant to your Prodigy Educations mailbox, so it can read the
inbox, draft, and send branded mail on your behalf.

It never holds your mail password. It talks to your running instance over the
same HTTP API the website uses, with a personal access token that you can
revoke at any time.

---

## 1. Get a token

Sign in at <https://email.prodigyeducations.com> → your initials, top right →
**Change password** → **AI access tokens** → name it, **Create token**.

The token is shown **once**. Copy it.

A token acts as you for mail and your signature. It is deliberately refused by
the administration routes, so a leaked token cannot create users or reassign
mailboxes.

## 2. Install

```bash
git clone https://github.com/commonnoorani-design/Prodigy-emil.git
cd Prodigy-emil/mcp
npm install
```

## 3. Point your assistant at it

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

## If it does not connect

- `curl https://email.prodigyeducations.com/api/health` should return JSON.
- A rejected token means it was revoked, or copied incompletely — make a new one.
- The server needs Node 18 or newer.
