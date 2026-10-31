// Signed vector-store sync relay for `decker chatty` / `decker publish`.
//
// Decker no longer holds an OpenAI API key. Instead it signs each vector-store
// request with the prompt's deckConfigKey (which it already has in
// chatty-key.json); the proxy verifies the signature, swaps in that prompt's
// apiKey and forwards the call to OpenAI. The OpenAI key lives only here.
//
// Contract (must stay byte-compatible with decker's Text.Decker.Chatty.Sync —
// see decker's test/fixtures/chatty-sync-fixture.json):
//
//   headers   X-Chatty-Prompt: <prompt id>
//             X-Chatty-Timestamp: <unix seconds>
//             X-Chatty-Signature: base64( HMAC-SHA256(deckConfigKey, canonical) )
//   canonical "decker-chatty-sync-v1" \n promptId \n timestamp \n METHOD \n
//             path-with-query (relative to the /sync mount) \n hex(sha256(body))
//
// Only the handful of operations decker's Upload.hs performs are relayed; this
// is not an open OpenAI passthrough.
import crypto from "node:crypto";

export const SIGNATURE_VERSION = "decker-chatty-sync-v1";
export const MAX_SKEW_SECONDS = 300;

const OPENAI_BASE = "https://api.openai.com/v1";

// Used for unknown prompt ids so they take the same code path (and roughly the
// same time) as a wrong signature: no prompt-id existence oracle.
const DUMMY_KEY = Buffer.alloc(32, 0);

export function canonicalString({ promptId, timestamp, method, path, body }) {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return [
    SIGNATURE_VERSION,
    promptId,
    String(timestamp),
    method.toUpperCase(),
    path,
    bodyHash,
  ].join("\n");
}

export function sign(key, fields) {
  return crypto
    .createHmac("sha256", key)
    .update(canonicalString(fields), "utf8")
    .digest("base64");
}

// Verify a sync request. Returns { ok: true, entry } with the prompt's config
// entry, or { ok: false, reason } (reason is for the server log only; clients
// get one generic message).
export function verifySyncRequest(prompts, req, nowSeconds) {
  const { promptId, timestamp, signature, method, path, body } = req;
  if (!promptId || !timestamp || !signature) {
    return { ok: false, reason: "missing signature headers" };
  }
  if (!/^\d+$/.test(timestamp)) {
    return { ok: false, reason: "malformed timestamp" };
  }
  const entry = Object.hasOwn(prompts, promptId) ? prompts[promptId] : null;
  const key = entry ? entry.deckConfigKey : DUMMY_KEY;
  const expected = Buffer.from(
    sign(key, { promptId, timestamp, method, path, body }),
    "base64"
  );
  const given = Buffer.from(signature, "base64");
  const sigOk =
    given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!entry || !sigOk) {
    return { ok: false, reason: entry ? "bad signature" : "unknown promptId" };
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "timestamp outside allowed skew (check clocks)" };
  }
  return { ok: true, entry };
}

const ID = "[A-Za-z0-9_-]+";

// method, path regex (no query), body kind. "upload" is a raw file body that
// the proxy wraps into OpenAI's multipart /files upload.
const ROUTES = [
  ["GET", new RegExp(`^/vector_stores$`), "none"],
  ["GET", new RegExp(`^/vector_stores/${ID}$`), "none"],
  ["POST", new RegExp(`^/vector_stores$`), "json"],
  ["GET", new RegExp(`^/vector_stores/${ID}/files$`), "none"],
  ["POST", new RegExp(`^/vector_stores/${ID}/files$`), "json"],
  ["DELETE", new RegExp(`^/vector_stores/${ID}/files/${ID}$`), "none"],
  ["GET", new RegExp(`^/files$`), "none"],
  ["POST", new RegExp(`^/files$`), "upload"],
  ["DELETE", new RegExp(`^/files/${ID}$`), "none"],
];

// Map a sync request onto an allowed OpenAI operation, or null if it is not
// one of the relayed operations.
export function routeSync(method, path) {
  const url = new URL(path, "http://relay.invalid");
  const route = ROUTES.find(
    ([m, re]) => m === method.toUpperCase() && re.test(url.pathname)
  );
  if (!route) return null;
  const kind = route[2];
  if (kind === "upload") {
    const filename = url.searchParams.get("filename");
    if (!filename) return null;
    return { method: "POST", upstreamPath: "/files", kind, filename };
  }
  return { method: route[0], upstreamPath: url.pathname + url.search, kind };
}

// Build the fetch() arguments for the upstream OpenAI call.
export function buildUpstreamRequest(route, { body, apiKey }) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const init = { method: route.method, headers };
  if (route.kind === "json") {
    headers["Content-Type"] = "application/json";
    init.body = body;
  } else if (route.kind === "upload") {
    const form = new FormData();
    form.append("purpose", "assistants");
    form.append("file", new Blob([body]), route.filename);
    init.body = form; // fetch sets the multipart Content-Type with boundary
  }
  return { url: OPENAI_BASE + route.upstreamPath, init };
}
