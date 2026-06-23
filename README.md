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

Edit `config.json`:

``` json
{
  "port": 3000,
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
- `apiKey` — the OpenAI API key for that prompt. Rotating it is free (no deck
  recompile needed).
- `deckConfigKey` — the 32-byte AES-256-GCM key shared with decker. Generate
  with `openssl rand -base64 32`. It **must equal** the key in the deck author's
  git-controlled `chatty-key.json`. Rotating it requires recompiling every deck
  that uses this prompt id.

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

## Back-compat

A request without a `sealed` blob but with a legacy `prompt.id` is forwarded
as-is (the old stored-prompt path), using that prompt's `apiKey`. This keeps
already-published decks working until OpenAI removes stored prompts; remove it
once all decks have been recompiled with sealed config.

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