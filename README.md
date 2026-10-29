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
- `dbPath` (optional, default `./chatty.db`) — the SQLite session log (the
  `DB_PATH` environment variable wins).
- `cookieSecret` (optional) — signs the admin login cookie. **The admin UI is
  disabled without it.** Generate with `openssl rand -base64 48`.
- `cookieSecure` (default `true`) — `Secure` flag on the login cookie. Set it to
  `false` only for local testing over plain HTTP.
- `syncBodyLimit` (optional, default `"50mb"`) — maximum vector-store upload size.
- top-level `apiKey` (optional) — fallback key used only for the legacy
  stored-prompt path (old decks with no sealed blob); see *Back-compat*.

Node ≥ 22.5 is required (built-in `node:sqlite`).

``` bash
npm ci       # or npm install to update package-lock.json
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

# Deployment

Two options: the Docker image (below) or a systemd service running straight
from a checkout (*Running as a systemd service*). Both read the same
`config.json` and sit behind the same Caddy setup.

# Running with Docker

GitHub Actions (`.github/workflows/docker.yml`) runs the tests and then builds a
multi-arch (amd64/arm64) image and pushes it to the GitHub Container Registry:

| Trigger            | Tags                                  |
| ------------------ | ------------------------------------- |
| push to `main`     | `latest`, `sha-<short>`               |
| tag `v1.2.3`       | `1.2.3`, `1.2`, `sha-<short>`         |
| pull request       | built and tested, not pushed          |

```
ghcr.io/decker-edu/decker-chatty
```

The image contains no secrets. `config.json` is mounted at runtime, and the
session log goes to the `/data` volume. The image sets `PORT=3000` and
`DB_PATH=/data/chatty.db`, which override `port` and `dbPath` from
`config.json`, so you can use the same file for systemd and Docker. The process
runs as the unprivileged `node` user, and a `HEALTHCHECK` polls `/health`.

## Installation

Copy `docker-compose.yml` and a filled-in `config.json` to a directory on the
host. A checkout is not required:

``` bash
cp config-example.json config.json   # then fill in the real secrets
chmod 644 config.json                # the container's node user must be able to read it
docker compose up -d
```

The example compose file publishes the proxy on `127.0.0.1:3000` only, which
matches the Caddy config above when Caddy runs on the host. If Caddy runs in
Docker, drop `ports`, put both containers on a shared network (see the commented
lines in `docker-compose.yml`) and use `reverse_proxy chatty:3000`.

If the GHCR package is private, run `docker login ghcr.io` first with a token
that has `read:packages`. Alternatively, make the package public in its GitHub
settings.

## Usage

``` bash
docker compose logs -f chatty     # console log
docker compose ps                 # status + health
docker compose restart chatty     # after a config.json change
docker compose pull && docker compose up -d   # update to the latest image
```

To build locally instead of pulling, run `docker build -t decker-chatty .` and set
`image: decker-chatty` in the compose file.

## Moving the session log from systemd to Docker

Stop the systemd service first, so the SQLite WAL is checkpointed into
`chatty.db`. Then copy the file into the volume:

``` bash
sudo systemctl stop decker-chatty.service
docker compose create
docker compose cp chatty.db chatty:/data/chatty.db
docker compose run --rm --user root --entrypoint chown chatty node:node /data/chatty.db
docker compose up -d
```

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
