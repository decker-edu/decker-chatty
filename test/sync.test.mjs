import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sign,
  verifySyncRequest,
  routeSync,
  buildUpstreamRequest,
  MAX_SKEW_SECONDS,
} from "../sync.mjs";

// Mirrored from decker's test/fixtures/chatty-sync-fixture.json. The Haskell
// signer must produce exactly these signatures.
const FX = {
  keyHex:
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  promptId: "pmpt_fixture_0001",
  timestamp: "1700000000",
  post: {
    method: "POST",
    path: "/vector_stores/vs_fixture_abc123/files",
    body: '{"file_id":"file-abc"}',
    signature: "lNzZtooSHqfiBfDJbBLRCodotMR+33MER2FrOu2zXWM=",
  },
  get: {
    method: "GET",
    path: "/files?purpose=assistants&limit=10000",
    body: "",
    signature: "H45jpok0Q1npAjrf73kon+TPOpK+xV1lJDf7Llio6tg=",
  },
};

const key = Buffer.from(FX.keyHex, "hex");
const prompts = { [FX.promptId]: { apiKey: "sk-test", deckConfigKey: key } };
const now = Number(FX.timestamp);

function req(c, overrides = {}) {
  return {
    promptId: FX.promptId,
    timestamp: FX.timestamp,
    signature: c.signature,
    method: c.method,
    path: c.path,
    body: Buffer.from(c.body),
    ...overrides,
  };
}

test("sign reproduces the frozen fixture signatures (cross-impl contract)", () => {
  for (const c of [FX.post, FX.get]) {
    const { signature, ...fields } = req(c);
    assert.equal(sign(key, fields), c.signature);
  }
});

test("verifySyncRequest accepts a correctly signed request", () => {
  const v = verifySyncRequest(prompts, req(FX.post), now);
  assert.equal(v.ok, true);
  assert.equal(v.entry.apiKey, "sk-test");
});

test("verifySyncRequest rejects a tampered body, path or method", () => {
  for (const o of [
    { body: Buffer.from('{"file_id":"file-evil"}') },
    { path: "/vector_stores/vs_other/files" },
    { method: "DELETE" },
  ]) {
    assert.equal(verifySyncRequest(prompts, req(FX.post, o), now).ok, false);
  }
});

test("verifySyncRequest rejects unknown prompts and missing headers", () => {
  assert.equal(
    verifySyncRequest(prompts, req(FX.post, { promptId: "pmpt_nope" }), now).ok,
    false
  );
  assert.equal(
    verifySyncRequest(prompts, req(FX.post, { signature: undefined }), now).ok,
    false
  );
  assert.equal(
    verifySyncRequest(prompts, req(FX.post, { promptId: "__proto__" }), now).ok,
    false
  );
});

test("verifySyncRequest enforces the timestamp window", () => {
  assert.equal(
    verifySyncRequest(prompts, req(FX.post), now + MAX_SKEW_SECONDS).ok,
    true
  );
  assert.equal(
    verifySyncRequest(prompts, req(FX.post), now + MAX_SKEW_SECONDS + 1).ok,
    false
  );
  assert.equal(
    verifySyncRequest(prompts, req(FX.post, { timestamp: "17e8" }), now).ok,
    false
  );
});

test("routeSync allows exactly the operations decker performs", () => {
  assert.deepEqual(routeSync("GET", "/vector_stores/vs_1"), {
    method: "GET",
    upstreamPath: "/vector_stores/vs_1",
    kind: "none",
  });
  assert.equal(routeSync("POST", "/vector_stores").kind, "json");
  assert.equal(
    routeSync("GET", "/vector_stores?limit=100&after=vs_1").upstreamPath,
    "/vector_stores?limit=100&after=vs_1"
  );
  assert.equal(
    routeSync("GET", "/vector_stores/vs_1/files?limit=100&after=file-x")
      .upstreamPath,
    "/vector_stores/vs_1/files?limit=100&after=file-x"
  );
  assert.equal(routeSync("POST", "/vector_stores/vs_1/files").kind, "json");
  assert.equal(routeSync("DELETE", "/vector_stores/vs_1/files/file-1").kind, "none");
  assert.equal(routeSync("GET", "/files?purpose=assistants").kind, "none");
  assert.equal(routeSync("DELETE", "/files/file-1").kind, "none");
  assert.deepEqual(routeSync("POST", "/files?filename=a%20b.md"), {
    method: "POST",
    upstreamPath: "/files",
    kind: "upload",
    filename: "a b.md",
  });
});

test("routeSync refuses everything else", () => {
  assert.equal(routeSync("POST", "/responses"), null);
  assert.equal(routeSync("DELETE", "/vector_stores/vs_1"), null);
  assert.equal(routeSync("GET", "/files/file-1/content"), null);
  assert.equal(routeSync("POST", "/files"), null); // upload needs a filename
  assert.equal(routeSync("GET", "/vector_stores/../responses"), null);
});

test("buildUpstreamRequest swaps in the prompt's apiKey", async () => {
  const json = buildUpstreamRequest(routeSync("POST", "/vector_stores"), {
    body: Buffer.from('{"name":"x"}'),
    apiKey: "sk-test",
  });
  assert.equal(json.url, "https://api.openai.com/v1/vector_stores");
  assert.equal(json.init.headers.Authorization, "Bearer sk-test");
  assert.equal(json.init.headers["Content-Type"], "application/json");

  const up = buildUpstreamRequest(routeSync("POST", "/files?filename=n.md"), {
    body: Buffer.from("# hi"),
    apiKey: "sk-test",
  });
  assert.equal(up.url, "https://api.openai.com/v1/files");
  assert.equal(up.init.body.get("purpose"), "assistants");
  const file = up.init.body.get("file");
  assert.equal(file.name, "n.md");
  assert.equal(await file.text(), "# hi");
});
