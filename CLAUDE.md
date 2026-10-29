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

- `server.mjs` — Express app, the chat (`POST /`) and `/health` routes, SSE streaming.
  Also opens the session-log DB, records each sealed turn, and mounts the admin
  router.
- `seal.mjs` — pure crypto/config helpers (no Express): `decodeKey`,
  `loadPrompts`, `openConfig`, `buildUpstreamBody`. **Unit-tested; keep logic
  here, not in the route handler.**
- `logging.mjs` — pure `extractLogFields` (no Express/DB): turns a request +
  terminal SSE event into a log row. **Unit-tested.**
- `db.mjs` — session-log store over built-in `node:sqlite` (no native dep):
  schema, `insertTurn` (session-id chaining), scoped read/delete helpers.
  **Unit-tested.**
- `admin.mjs` — `express.Router()` for the admin UI: cookie auth, session list,
  transcript. Self-contained (no session-store / cookie-parser dep).
- `views.mjs` — server-rendered HTML templates (plain strings, HTML-escaped).
- `markdown.mjs` — `renderMarkdown`: safe markdown → HTML with math preserved
  for MathJax (`markdown-it`, `html:false`). **Unit-tested.**
- `public/` — `styles.css` (neobrutalist), vendored `htmx.min.js`, and vendored
  `vendor/mathjax/tex-svg.js` (MathJax v3, self-contained SVG output).
- `test/*.test.mjs` — `node --test` suites (seal, logging, db). Run `npm test`.
- `config.json` — **git-ignored**, holds real secrets. Copy from
  `config-example.json`.
- `config-example.json` — committed placeholder config.
- `chatty.db` — **git-ignored** SQLite session log (created at runtime).
- `decker-chatty.service` — systemd unit (runs Homebrew's node on this host, logs
  to the journal: `journalctl -u decker-chatty`).
- `Dockerfile` / `.dockerignore` / `docker-compose.yml` — the alternative Docker
  deployment. The image (`node:24-alpine`, runs as `node`) carries **no
  secrets**: `config.json` is mounted read-only at `/app/config.json`, the
  session log lives on the `/data` volume (`DB_PATH=/data/chatty.db`). Keep
  `config.json` and `chatty.db*` in `.dockerignore`.
- `.github/workflows/docker.yml` — CI: `npm test`, then build amd64/arm64 and
  push to `ghcr.io/decker-edu/decker-chatty` (`latest` from `main`, semver tags
  from `v*` tags; PRs build without pushing).

## Commands

```sh
npm install
npm start        # node server.mjs
npm test         # node --test (test/*.test.mjs)
```

## Request flow (`POST /`)

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

## Session logging & admin UI

Every **sealed** turn is recorded to a SQLite session log; the **legacy** path is
deliberately **not** logged (its `prompt.id` is OpenAI's, not one of our
selectors, and no admin can authenticate to read it).

**What a "session" is.** The proxy is otherwise stateless — conversation
threading lives on OpenAI's side via `previous_response_id`. `db.insertTurn`
reconstructs a thread at write time: a turn with no `previous_response_id`
starts a new `session_id`; a follow-up inherits the `session_id` of the turn
whose `response_id` it replies to (found via the captured `response.completed`
id). Sessions are **anonymous** — the proxy sees no student identity.

**What is stored / not stored.** Input text, output text, model, usage, status
and errors are stored in full (that's the point). **Never stored:** api keys and
the decrypted `instructions` — the admin who reads the log already authored the
instructions, and `extractLogFields` has no field that could carry them (there's
a unit test asserting this). This is a **deliberate reversal** of the
"never log conversation content" rule that still applies to the **stdout/journald**
logs — that rule is about the console, not this purpose-built store.

**Capture path.** `streamUpstream` keeps the last terminal SSE event and calls
`recordTurn` at every exit (completed / failed / incomplete / upstream-error /
network-error / silent-end). Logging is wrapped so a DB failure can **never**
break the proxy response.

**Admin auth.** `admin.mjs` is mounted at `/admin` and is **only enabled when `config.cookieSecret` is set** (that secret signs the
login cookie). Credentials are **prompt id + that prompt's `deckConfigKey`**,
compared in constant time (`crypto.timingSafeEqual`); unknown prompt ids take the
same path as a wrong key (no existence oracle) and there's an in-memory login
throttle. On success a short (12h) HMAC-signed `HttpOnly; SameSite=Lax` cookie is
set with **no `Path` attribute**, so the browser scopes it to the directory of
the login URL, i.e. the public admin root (`/chatty/admin` behind the Caddy
setup below). That keeps it away from the host's other apps without the proxy
knowing its prefix; don't switch it to `Path=/`. Every data route is **scoped to the promptId in
the verified cookie** — an admin only ever sees their own prompt's traffic. UI is
server-rendered HTML + htmx (progressive: full-page nav works without JS);
transcript view returns a bare fragment when `HX-Request: true`.

**Transcript rendering.** Student input and bot output are rendered as markdown
with embedded math (decker decks use both). `markdown.mjs` runs `markdown-it`
with `html:false` so any raw HTML in the untrusted content is **escaped, not
emitted** — that's the XSS boundary, no client-side sanitizer involved. Math is
pulled out to inert placeholders **before** markdown runs and restored
(HTML-escaped, delimiters intact) **after**, so markdown never mangles TeX
(`_`, `*`, `\`, backticks). The vendored MathJax (SVG output, no runtime font
fetches) typesets `$…$`/`\(…\)` inline and `$$…$$`/`\[…\]` display client-side;
an `htmx:afterSwap` handler re-typesets a transcript swapped into `#detail`.
Everything else in the UI (previews, ids, errors) stays plain `escapeHtml`.

**Retention.** Currently infinite by decision. `db.deleteSession` /
`db.deleteBefore` exist (prompt-scoped) but the purge UI is **deferred** — wiring
a route to them is the only work needed to expose it.

**Behind Caddy (path prefix).** The proxy never knows its public prefix. It
serves the chat endpoint at `POST /`, the sync relay at `/sync/*`, the admin UI
at `/admin/*` and `/health`; the reverse proxy mounts the whole app anywhere and
strips its prefix. A deck's `chatty.server` is exactly that public mount URL:
decker POSTs chat requests to it as-is and sends sync calls to
`<chatty.server>/sync/…`. The admin UI keeps this working by using relative URLs only:
- every page sits directly under the admin root (the transcript is
  `session?prompt=…&id=…`, not a nested path), so links, form actions and
  redirect `Location`s are relative and there's no `<base>`;
- `…/admin` (no trailing slash) is redirected to `admin/`, the one URL where
  relative links would resolve one level too high;
- `express.static` runs with `redirect: false`, because its directory redirect
  builds an absolute `Location` that would lose the prefix.

Example with `chatty.server: "https://example.org/chatty"`. The matcher must
include the bare `/chatty` (the chat POST); `handle_path /chatty/*` alone misses
it:

```caddy
example.org {
  @chatty path /chatty /chatty/*
  handle @chatty {
    uri strip_prefix /chatty   # /chatty -> /, /chatty/sync/… -> /sync/…, /chatty/admin/ -> /admin/
    reverse_proxy 127.0.0.1:3000 {
      flush_interval -1        # stream SSE replies without buffering
    }
  }
}
```

## Vector store sync relay (`/sync/*`)

The relay lets decker sync its vector store without holding an OpenAI key. The
logic lives in `sync.mjs`: `canonicalString`/`sign`, `verifySyncRequest`, the
`ROUTES` allowlist with `routeSync`, and `buildUpstreamRequest`. It is pure and
unit-tested in `test/sync.test.mjs`. The handler in `server.mjs` is registered
**before** `express.json()` because the HMAC covers the raw body bytes.

- Auth uses an HMAC-SHA256 signature made with the prompt's `deckConfigKey`, the
  same key decker reads from `chatty-key.json`. The signature covers prompt id,
  timestamp (±300 s), method, path with query relative to the `/sync` mount,
  and sha256 of the body. Unknown prompt ids are checked against a dummy key, so they
  can't be told apart from a bad signature.
- Only the operations decker's `Upload.hs` performs are relayed. Uploads arrive as
  raw bytes with `?filename=`, and the proxy wraps them into multipart.
- A `401` always means the signature was rejected. If OpenAI returns a 401 for our
  `apiKey`, the proxy maps it to `502`.
- The contract is shared with decker's `Text.Decker.Chatty.Sync`. The fixture is
  in decker's `test/fixtures/chatty-sync-fixture.json`, and both test suites
  check it.
- Not yet scoped per store: a holder of a prompt's `deckConfigKey` can reach any
  vector store and file under that prompt's `apiKey`, including `--prune-files`
  deleting every `assistants` file in the project. Give each prompt its own
  OpenAI project key when prompts must be kept apart.

Keep `cookieSecure: true` in production (HTTPS via Caddy); set it to `false` only
for local plain-HTTP testing.

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
  "dbPath": "./chatty.db (optional; session-log SQLite file)",
  "cookieSecret": "optional; when set, enables the admin UI and signs its cookie",
  "cookieSecure": true,
  "prompts": {
    "<prompt-id>": {
      "apiKey": "sk-... OpenAI key for this prompt",
      "deckConfigKey": "base64 32-byte key, MUST match the author's chatty-key.json"
    }
  }
}
```

- `dbPath` — session log location; defaults to `./chatty.db`. Git-ignored.
  The `DB_PATH` env var overrides it (as `PORT` overrides `port`); the Docker
  image sets both.
- `cookieSecret` — signs the admin login cookie; **admin UI is disabled without
  it**. Use a long random string.
- `cookieSecure` — `Secure` flag on the login cookie; keep `true` in production,
  `false` only for local plain-HTTP testing.

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

- ESM (`.mjs`, `"type"` via explicit extensions). **Node ≥ 22.5** now, for the
  built-in `node:sqlite` (`db.mjs`) and `import.meta.dirname` (`admin.mjs`), on
  top of `fetch`, `crypto`, and `node --test`. No native modules, no build step.
- Never log or echo secrets (api keys, deck-config keys, decrypted instructions)
  **to the console**. The SQLite session store deliberately keeps conversation
  content but still never stores keys or instructions — see the section above.
- `config.json` is git-ignored — never commit real keys; edit
  `config-example.json` for documentation changes.
- Keep crypto and body-assembly in `seal.mjs`, log-row extraction in
  `logging.mjs`, and store logic in `db.mjs` — all pure and unit-tested. The
  route handler and `admin.mjs` should only do lookups, error responses,
  streaming and rendering.
- Functional client assets are **vendored** in `public/` (pin the version):
  `htmx.min.js` and `vendor/mathjax/tex-svg.js` — the admin path stays usable
  without outbound internet. The **one** deliberate CDN dependency is Google
  Fonts (Big Shoulders / Archivo / IBM Plex Mono, matching siloserver.org's
  look); it's aesthetic-only and degrades to system stacks in `styles.css`.
- Styling matches **siloserver.org**'s refined "blueprint/console"
  neobrutalism: thin 1.5px ink borders, hard offset shadows (no blur), sharp
  corners, warm cream paper, saturated blue/red/orange/green accents. Tokens in
  `styles.css` mirror its variable names; light + dark via `prefers-color-scheme`.
- The matching client/author code lives in the **decker** repo:
  `resource/decker/support/chatty/chatty.js` (sends the body),
  `src/Text/Decker/Chatty/Seal.hs` + `MetaSeal.hs` (seals at build time).
