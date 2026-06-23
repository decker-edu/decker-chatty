# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

`decker-chatty` is a small Node/Express **proxy** that relays chat messages from
[decker](https://github.com/decker-edu/decker) slide decks to OpenAI's
**Responses API** (`https://api.openai.com/v1/responses`), streaming the SSE
reply back to the browser. It is the server-side half of decker's `chatty`
plugin ("Prof. Bot").

The proxy holds the secrets (OpenAI API keys and the per-prompt encryption keys);
the browser never sees an API key and does no crypto. It is meant to run behind a
reverse proxy that terminates TLS and handles client authentication.

## Why it exists / history

OpenAI deprecated **stored prompts** (the chat-project mechanism), where the
system prompt, model and vector store lived on the platform keyed by a `pmpt_…`
id. Decker decks used to just send that id.

The replacement: the deck author's config — **system prompt (instructions),
model, params, vector store id** — is encrypted ("sealed") by decker at compile
time and embedded in the published deck. This proxy **decrypts the blob per
request** and injects model + instructions + the `file_search` tool itself. This
keeps the system prompt unreadable/untamperable by the client while letting
authors iterate on prompts by editing markdown (no proxy change needed).

See decker's `doc/chatty-sealed-config.md` for the full design.

## Files

- `server.mjs` — Express app, the `/chatty` and `/health` routes, SSE streaming.
- `seal.mjs` — pure crypto/config helpers (no Express): `decodeKey`,
  `loadPrompts`, `openConfig`, `buildUpstreamBody`. **Unit-tested; keep logic
  here, not in the route handler.**
- `test/seal.test.mjs` — `node --test` suite. Run with `npm test`.
- `config.json` — **git-ignored**, holds real secrets. Copy from
  `config-example.json`.
- `config-example.json` — committed placeholder config.
- `decker-chatty.service` — systemd unit (runs `node server.mjs`, logs to
  `chatty.log`).

## Commands

```sh
npm install
npm start        # node server.mjs
npm test         # node --test (test/*.test.mjs)
```

## Request flow (`POST /chatty`)

The handler accepts one JSON body and branches on whether a `sealed` blob is
present:

1. **Sealed path** (new decks) — body `{ promptId, sealed, input,
   previous_response_id, stream }`:
   - look up `prompts[promptId]` → `400` if unknown;
   - `openConfig(deckConfigKey, promptId, sealed)` decrypts the payload →
     `400 invalid sealed config` on any failure (tamper, wrong key, wrong AAD);
   - `buildUpstreamBody` assembles the OpenAI request from the **decrypted
     payload only** — any client-supplied `model`/`instructions`/`tools` are
     ignored;
   - stream the response using that prompt's `apiKey`.
2. **Legacy path** (old already-published decks, no `sealed`) — body
   `{ prompt: { id: "pmpt_…" }, … }`:
   - forwarded to OpenAI **as-is** using the **top-level** `config.apiKey`;
   - `prompt.id` is a real OpenAI stored-prompt id resolved by OpenAI, **not**
     one of our selectors, so it is deliberately **not** looked up in `prompts`;
   - exists only until OpenAI removes stored prompts — then delete this branch
     and the top-level `apiKey`.

`stream` defaults to on. On a first turn (`!previous_response_id`) the system
`instructions` are sent; on later turns OpenAI carries them via
`previous_response_id`, so only `model`/`params`/`tools` are re-sent.

## Crypto contract (do not break)

AES-256-GCM. Wire format: `base64( nonce(12) || ciphertext || tag(16) )`, with
the **prompt id as additional authenticated data (AAD)**. The plaintext payload
is JSON: `{ instructions, model, params, vector_store_id }`.

This contract is shared with decker's Haskell sealing code. The frozen test
vector lives in **decker's** `test/fixtures/chatty-seal-fixture.json` and is
mirrored as the `FX` constant in `test/seal.test.mjs`. **Both implementations
must reproduce that exact blob** — if you touch the crypto, run `npm test` here
*and* `stack test` in decker, and update the fixture (and its decker generator
`test/fixtures/gen-seal-fixture.mjs`) on both sides together.

## `config.json` schema

```json
{
  "port": 3000,
  "apiKey": "sk-... optional, legacy fallback for old unsealed decks",
  "prompts": {
    "<prompt-id>": {
      "apiKey": "sk-... OpenAI key for this prompt",
      "deckConfigKey": "base64 32-byte key, MUST match the author's chatty-key.json"
    }
  }
}
```

- `prompts` is keyed by **prompt id** (the deck's `chatty.prompt`) — now just a
  selector, no longer an OpenAI stored-prompt id.
- `deckConfigKey` must be **byte-for-byte identical** to the key in the deck
  author's git-controlled `chatty-key.json`. Validated to 32 bytes at startup
  (`loadPrompts`), so a length mismatch fails fast; a content mismatch surfaces
  as `400 invalid sealed config` per request.
- Rotating a prompt's `apiKey` is free; rotating its `deckConfigKey` requires the
  author to recompile every deck that uses that prompt id.
- top-level `apiKey` is only used by the legacy path.

## Conventions / gotchas

- ESM (`.mjs`, `"type"` via explicit extensions). Node ≥ 18 for built-in
  `fetch`, `crypto.createDecipheriv("aes-256-gcm")`, and `node --test`.
- Never log or echo secrets (api keys, deck-config keys, decrypted instructions).
- `config.json` is git-ignored — never commit real keys; edit
  `config-example.json` for documentation changes.
- Keep crypto and body-assembly in `seal.mjs` so they stay unit-testable; the
  route handler should only do lookups, error responses and streaming.
- The matching client/author code lives in the **decker** repo:
  `resource/decker/support/chatty/chatty.js` (sends the body),
  `src/Text/Decker/Chatty/Seal.hs` + `MetaSeal.hs` (seals at build time).
