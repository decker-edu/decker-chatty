# Description

Small script that creates a proxy that relays messages to ChatGPT (the OpenAI
Responses API) using a provided API key.

Used by decker's `chatty` plugin to allow chatting with Prof. Bot.

The proxy no longer relies on OpenAI's deprecated stored prompts. Instead, each
deck carries a **sealed config** blob — the system prompt, model, params and
vector store id, encrypted by decker at compile time. The proxy decrypts it per
request and injects model + instructions + the `file_search` tool itself.
Client-supplied `model`/`instructions`/`tools` are ignored.

# Setup

Copy `config-example.json` to `config.json` and edit it (the real `config.json`
holds secrets and is git-ignored):

``` json
{
  "port": 3000,
  "apiKey": "sk-... legacy fallback key, optional",
  "prompts": {
    "pmpt_example": {
      "apiKey": "sk-...",
      "deckConfigKey": "base64 32-byte deck-config key"
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
- top-level `apiKey` (optional) — fallback key used only for the legacy
  stored-prompt path (old decks with no sealed blob); see *Back-compat*.

``` bash
npm install
npm start
npm test     # unit tests (crypto contract, body assembly)
```

Configure your reverse proxy to relay `https://` requests to the running service.

## Crypto contract

AES-256-GCM, wire format `base64( nonce(12) || ciphertext || tag(16) )`, with the
prompt id as additional authenticated data (AAD). The frozen test vector lives in
decker's `test/fixtures/chatty-seal-fixture.json`; both this proxy and decker's
Haskell sealing code are checked against it (`npm test` / `stack test`).

## Vector store sync relay (`/chatty/sync`)

`decker chatty` and `decker publish` keep the deck's OpenAI vector store in sync.
Decker holds **no OpenAI API key**. Instead it sends those calls to this proxy at
`<chatty.server>/chatty/sync/...`, signed with the prompt's `deckConfigKey`. The proxy
checks the signature and forwards the call to OpenAI using that prompt's `apiKey`,
so the OpenAI key lives only in `config.json`.

- Headers: `X-Chatty-Prompt`, `X-Chatty-Timestamp` (unix seconds) and
  `X-Chatty-Signature` = base64 HMAC-SHA256 over
  `decker-chatty-sync-v1 \n promptId \n timestamp \n METHOD \n path?query \n hex(sha256(body))`.
  Timestamps more than 5 minutes off are rejected.
- Only the vector-store and file operations decker uses are relayed (see
  `ROUTES` in `sync.mjs`). Anything else gets a `404`.
- File uploads arrive as raw bytes (`POST /chatty/sync/files?filename=…`). The proxy
  turns them into OpenAI's multipart `purpose=assistants` upload.
- A `401` from the proxy always means the signature was rejected. If OpenAI
  rejects the proxy's own `apiKey`, the proxy returns a `502`.
- `syncBodyLimit` (optional, default `"50mb"`) caps the upload size.
- All public routes live under `/chatty` (chat, `/chatty/sync/*`,
  `/chatty/admin/*`), so a single reverse-proxy matcher such as Caddy's
  `handle /chatty*` covers them (see `CLAUDE.md`).

The signing contract is pinned by decker's `test/fixtures/chatty-sync-fixture.json`
and mirrored in `test/sync.test.mjs`.

## Back-compat

A request without a `sealed` blob but with a legacy `prompt.id` is forwarded to
OpenAI as-is (the old stored-prompt path), using the **top-level** `apiKey`. The
`prompt.id` is an OpenAI stored-prompt id resolved by OpenAI, not one of our
selectors, so it is **not** looked up in `prompts` — old decks keep working
unchanged as long as a top-level `apiKey` is configured (use the key the stored
prompts were created with). If no top-level `apiKey` is set, legacy requests get
a `400`. Remove the top-level key once all decks have been recompiled with sealed
config (and OpenAI removes stored prompts).

# Running as a systemd service

To run the server as a systemd service that starts automatically on boot:

## Installation

``` bash
sudo cp decker-chatty.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable decker-chatty.service
sudo systemctl start decker-chatty.service
```

## Usage

``` bash
# Check service status
sudo systemctl status decker-chatty.service

# View logs
tail -f chatty.log

# Stop the service
sudo systemctl stop decker-chatty.service

# Restart the service
sudo systemctl restart decker-chatty.service

# Disable auto-start on boot
sudo systemctl disable decker-chatty.service
```

The service logs all output to `chatty.log` in the project directory.