// Crypto + config helpers for chatty sealed config.
//
// Contract (must stay byte-compatible with the Haskell sealing code in decker —
// see decker's test/fixtures/chatty-seal-fixture.json):
//   AES-256-GCM, wire = base64( nonce(12) || ciphertext || tag(16) ), AAD = prompt id.
import crypto from "node:crypto";

// Decode a base64 deck-config key and assert it is exactly 32 bytes.
export function decodeKey(b64, label = "deckConfigKey") {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    throw new Error(`${label} must be 32 bytes (base64), got ${buf.length}`);
  }
  return buf;
}

// Validate and index the config's prompt registry, decoding every key up front
// so a bad key fails at startup rather than on the first request.
export function loadPrompts(config) {
  const prompts = config.prompts || {};
  const out = {};
  for (const [id, entry] of Object.entries(prompts)) {
    if (!entry || typeof entry.apiKey !== "string") {
      throw new Error(`config: prompt "${id}" is missing apiKey`);
    }
    if (typeof entry.deckConfigKey !== "string") {
      throw new Error(`config: prompt "${id}" is missing deckConfigKey`);
    }
    if (entry.superAdmin !== undefined && typeof entry.superAdmin !== "boolean") {
      throw new Error(`config: prompt "${id}" superAdmin must be a boolean`);
    }
    out[id] = {
      apiKey: entry.apiKey,
      deckConfigKey: decodeKey(entry.deckConfigKey, `prompt "${id}" deckConfigKey`),
      // Optional: this prompt's admin credentials (promptId + deckConfigKey)
      // also unlock every other prompt's session logs, not just this one's.
      superAdmin: Boolean(entry.superAdmin),
    };
  }
  return out;
}

// Open a sealed blob with the given 32-byte key and prompt-id AAD. Returns the
// parsed payload object. Throws on a wrong key, wrong AAD, or any tampering.
export function openConfig(key, promptId, sealedB64) {
  const buf = Buffer.from(sealedB64, "base64");
  if (buf.length < 12 + 16) throw new Error("sealed blob too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(promptId, "utf8"));
  d.setAuthTag(tag);
  const plaintext = Buffer.concat([d.update(ct), d.final()]); // throws on tag mismatch
  return JSON.parse(plaintext.toString("utf8"));
}

// Assemble the upstream OpenAI Responses body from a decrypted payload and the
// client turn. Client-supplied model/instructions/tools are deliberately
// ignored; everything authoritative comes from the sealed payload.
export function buildUpstreamBody(payload, { input, previous_response_id, stream }) {
  const body = {
    model: payload.model,
    ...(payload.params || {}),
    input,
    stream: stream !== false,
    tools: [
      { type: "file_search", vector_store_ids: [payload.vector_store_id] },
    ],
  };
  if (previous_response_id) {
    body.previous_response_id = previous_response_id;
  } else {
    // Instructions (the system prompt) are only sent on the first turn; on
    // later turns the conversation state carries them via previous_response_id.
    body.instructions = payload.instructions;
  }
  return body;
}
