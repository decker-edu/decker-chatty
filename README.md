# Description

Small proxy that relays messages to ChatGPT (the OpenAI Responses API) using a
provided API key.

Used by decker's `chatty` plugin to allow chatting with Prof. Bot.

The proxy no longer relies on OpenAI's deprecated stored prompts. Instead, each
deck carries a **sealed config** blob — the system prompt, model, params and
vector store id, encrypted by decker at compile time. The proxy decrypts it per
request and injects model + instructions + the `file_search` tool itself.
Client-supplied `model`/`instructions`/`tools` are ignored.

## Routes

The proxy never needs to know its public URL. It serves everything relative to
its own root, and the reverse proxy mounts it under any prefix:

| Route      | Used by                                             |
| ---------- | --------------------------------------------------- |
| `POST /`   | the chatty plugin in published decks (chat, SSE)    |
| `/sync/*`  | `decker chatty` / `decker publish` (vector store)   |
| `/admin/*` | the session-log admin UI in a browser               |
| `/health`  | monitoring (`{"ok":true}`)                          |

A deck's `chatty.server` is exactly the public URL the proxy is mounted at.

# Setup

Copy `config-example.json` to `config.json` and edit it (the real `config.json`
holds secrets and is git-ignored):

``` json
{
  "port": 3000,
  "apiKey": "sk-... legacy fallback key, optional",
  "dbPath": "./chatty.db",
  "cookieSecret": "long random string",
  "cookieSecure": true,
  "prompts": {
    "my-prompt": {
      "apiKey": "sk-...",
      "deckConfigKey": "base64 32-byte deck-config key",
      "superAdmin": false
    }
  }
}
```

- `prompts` is keyed by **prompt id** (the deck's `chatty.prompt`, now just a
  selector — no longer an OpenAI stored-prompt id).
- `apiKey` (inside a prompt) — the OpenAI API key for that prompt. Rotating it is
  free (no deck recompile needed).
- `deckConfigKey` — the 32-byte AES-256-GCM key shared with decker. Generate
  with `openssl rand -base64 32`. It **must equal** the key in the deck author's
  git-controlled `chatty-key.json`. Rotating it requires recompiling every deck
  that uses this prompt id.
- `superAdmin` (optional) — this prompt's admin login may read every prompt's
  session log, not just its own.
- `port` — listen port (default `3000`; the `PORT` environment variable wins).
- `dbPath` (optional, default `./chatty.db`) — the SQLite session log.
- `cookieSecret` (optional) — signs the admin login cookie. **The admin UI is
  disabled without it.** Generate with `openssl rand -base64 48`.
- `cookieSecure` (default `true`) — `Secure` flag on the login cookie. Set it to
  `false` only for local testing over plain HTTP.
- `syncBodyLimit` (optional, default `"50mb"`) — maximum vector-store upload size.
- top-level `apiKey` (optional) — fallback key used only for the legacy
  stored-prompt path (old decks with no sealed blob); see *Back-compat*.

Node ≥ 22.5 is required (built-in `node:sqlite`).

``` bash
npm install
npm start
npm test     # unit tests (crypto and sync contracts, logging, store, markdown)
```

## Deck configuration

In the deck's `decker.yaml` (or deck meta), point `chatty.server` at the public
mount URL from the Caddy section below:

``` yaml
chatty:
  server: https://example.org/chatty
  prompt: my-prompt                  # key into "prompts" in config.json
  instructions: ./prompts/tutor.md
  model: gpt-4.1
  vector-store-id: vs_...
```

The plugin POSTs chat requests to `https://example.org/chatty`, and decker sends
its vector-store calls to `https://example.org/chatty/sync/…`.

# Running behind Caddy

The proxy speaks plain HTTP and is meant to sit behind a reverse proxy that
terminates TLS. With Caddy, mount it at a prefix and strip that prefix:

``` caddy
example.org {
	@chatty path /chatty /chatty/*
	handle @chatty {
		uri strip_prefix /chatty
		reverse_proxy 127.0.0.1:3000 {
			flush_interval -1
		}
	}

	# ... the rest of the site
}
```

Public URL → proxy route:

| Public                           | Proxy           |
| -------------------------------- | --------------- |
| `POST https://example.org/chatty` | `POST /`        |
| `https://example.org/chatty/sync/…` | `/sync/…`     |
| `https://example.org/chatty/admin/` | `/admin/`     |
| `https://example.org/chatty/health` | `/health`     |

Things that matter:

- **Match the bare prefix.** Chat is POSTed to `/chatty` itself (no trailing
  slash). `handle_path /chatty/*` does not match that, so use the named matcher
  with both `/chatty` and `/chatty/*` plus `uri strip_prefix`, as above.
- **`flush_interval -1`** — chat replies are streamed as server-sent events;
  without it Caddy may buffer them and the answer arrives in one lump.
- **Keep it outside any login wall.** Students' browsers call the chat endpoint
  from published decks, and the `decker` CLI calls `/sync`, so neither can pass
  an SSO login. If the site uses `forward_auth` (oauth2-proxy etc.), put the
  `handle @chatty` block **before** the authenticated `route`/`handle`, so
  Caddy's first-match `handle` ordering never reaches the auth for `/chatty`.
  Each part protects itself: sealed configs and per-prompt keys for chat,
  HMAC signatures for sync, a login for the admin UI.
- **CORS** is already handled by the proxy (it answers preflights and allows any
  origin), so no Caddy CORS headers are needed.
- **Any prefix works.** Mount it at `/bot`, say, by replacing `/chatty` in all
  three places, and set `chatty.server` to `https://example.org/bot`. The admin UI
  uses only relative links, and its login cookie is scoped to the admin path
  automatically, so nothing in the proxy needs to change.
- Keep `cookieSecure: true`; Caddy serves the site over HTTPS.

If Caddy runs in Docker, replace `127.0.0.1:3000` with an address the container
can reach (the host's IP or the Docker bridge gateway), and make sure the proxy
listens there.

After reloading Caddy (`caddy reload`, or `docker compose exec caddy caddy
reload`), check it:

``` bash
curl https://example.org/chatty/health                    # {"ok":true}
curl -sD - -o /dev/null https://example.org/chatty/admin  # 302, Location: admin/
```

# Admin UI

Enabled when `cookieSecret` is set, at `<chatty.server>/admin/` (e.g.
`https://example.org/chatty/admin/`). Sign in with a **prompt id** and that
prompt's **`deckConfigKey`**. You then see that prompt's logged chat sessions
(anonymous: student input and Prof. Bot's answers, rendered with markdown and
math), or every prompt's if it is a `superAdmin`.

Every sealed chat turn is stored in the SQLite log at `dbPath`. API keys and the
decrypted instructions are never stored. Retention is currently unlimited.

## Crypto contract

AES-256-GCM, wire format `base64( nonce(12) || ciphertext || tag(16) )`, with the
prompt id as additional authenticated data (AAD). The frozen test vector lives in
decker's `test/fixtures/chatty-seal-fixture.json`; both this proxy and decker's
Haskell sealing code are checked against it (`npm test` / `stack test`).

## Vector store sync relay (`/sync`)

`decker chatty` and `decker publish` keep the deck's OpenAI vector store in sync.
Decker holds **no OpenAI API key**. Instead it sends those calls to this proxy at
`<chatty.server>/sync/...`, signed with the prompt's `deckConfigKey`. The proxy
checks the signature and forwards the call to OpenAI using that prompt's `apiKey`,
so the OpenAI key lives only in `config.json`.

- Headers: `X-Chatty-Prompt`, `X-Chatty-Timestamp` (unix seconds) and
  `X-Chatty-Signature` = base64 HMAC-SHA256 over
  `decker-chatty-sync-v1 \n promptId \n timestamp \n METHOD \n path?query \n hex(sha256(body))`,
  where the path is relative to `/sync`. Timestamps more than 5 minutes off are
  rejected.
- Only the vector-store and file operations decker uses are relayed (see
  `ROUTES` in `sync.mjs`). Anything else gets a `404`.
- File uploads arrive as raw bytes (`POST /sync/files?filename=…`). The proxy
  turns them into OpenAI's multipart `purpose=assistants` upload.
- A `401` from the proxy always means the signature was rejected. If OpenAI
  rejects the proxy's own `apiKey`, the proxy returns a `502`.
- A holder of a prompt's `deckConfigKey` can reach every vector store and file
  under that prompt's `apiKey`. Give each prompt its own OpenAI project key when
  prompts must be kept apart.

The signing contract is pinned by decker's `test/fixtures/chatty-sync-fixture.json`
and mirrored in `test/sync.test.mjs`.

## Back-compat

A request without a `sealed` blob but with a legacy `prompt.id` is forwarded to
OpenAI as-is (the old stored-prompt path), using the **top-level** `apiKey`. The
`prompt.id` is an OpenAI stored-prompt id resolved by OpenAI, not one of our
selectors, so it is **not** looked up in `prompts`. If no top-level `apiKey` is
set, legacy requests get a `400`. Remove the top-level key once all decks have
been recompiled with sealed config (and OpenAI removes stored prompts).

# Running as a systemd service

`decker-chatty.service` runs the proxy as user `tramberend-admin` from
`/home/tramberend-admin/server/decker-chatty`. Adjust `User`,
`WorkingDirectory` and the node path in `ExecStart` for your host: it must be the
absolute path of a node ≥ 22.5 (`which node`). On this host that is Homebrew's
`/home/linuxbrew/.linuxbrew/bin/node`.

## Installation

``` bash
sudo cp decker-chatty.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now decker-chatty.service
```

## Usage

``` bash
# Check service status
sudo systemctl status decker-chatty.service

# Follow the logs (they go to the journal)
journalctl -u decker-chatty -f

# Restart after a code or config.json change
sudo systemctl restart decker-chatty.service

# Stop / disable auto-start on boot
sudo systemctl stop decker-chatty.service
sudo systemctl disable decker-chatty.service
```

The console log has a few lines per request (request id, prompt id, model,
status, token usage, errors) but never conversation content or secrets;
conversations go only to the session log.
