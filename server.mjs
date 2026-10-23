// npm install express cors
// node server.mjs

import express from "express";
import cors from "cors";

import config from "./config.json" with { type: "json" };
import { loadPrompts, openConfig, buildUpstreamBody } from "./seal.mjs";
import { verifySyncRequest, routeSync, buildUpstreamRequest } from "./sync.mjs";
import { extractLogFields } from "./logging.mjs";
import { openDb } from "./db.mjs";
import { createAdminRouter } from "./admin.mjs";

// Decode and validate every deck-config key at startup (fail fast).
let prompts;
try {
  prompts = loadPrompts(config);
} catch (err) {
  console.error(`[chatty] fatal: invalid config.json: ${err.message}`);
  process.exit(1);
}

const app = express();
app.use(cors()); // relax or remove in production

// Vector-store sync relay for decker (see sync.mjs). Registered before
// express.json() because the signature covers the raw body bytes. Like the
// admin UI it lives under /chatty, so one reverse-proxy prefix covers all.
app.use(
  "/chatty/sync",
  express.raw({ type: () => true, limit: config.syncBodyLimit || "50mb" }),
  async (req, res) => {
    const reqId = newReqId();
    const promptId = req.get("x-chatty-prompt");
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const verdict = verifySyncRequest(
      prompts,
      {
        promptId,
        timestamp: req.get("x-chatty-timestamp"),
        signature: req.get("x-chatty-signature"),
        method: req.method,
        path: req.url,
        body,
      },
      Math.floor(Date.now() / 1000)
    );
    if (!verdict.ok) {
      console.warn(
        `[chatty ${reqId}] sync rejected promptId=${promptId} reason=${verdict.reason}`
      );
      return fail(res, reqId, 401, "sync request not authorized");
    }

    const route = routeSync(req.method, req.url);
    if (!route) {
      console.warn(`[chatty ${reqId}] sync unsupported ${req.method} ${req.url}`);
      return fail(res, reqId, 404, "unsupported sync operation");
    }

    const { url, init } = buildUpstreamRequest(route, {
      body,
      apiKey: verdict.entry.apiKey,
    });
    let upstream;
    try {
      upstream = await fetch(url, init);
    } catch (err) {
      console.error(`[chatty ${reqId}] sync failed to reach OpenAI: ${err.message}`);
      return fail(res, reqId, 502, "could not reach OpenAI");
    }
    console.log(
      `[chatty ${reqId}] sync promptId=${promptId} ${req.method} ${req.url} -> ${upstream.status}`
    );
    const text = await upstream.text();
    // A 401 from OpenAI means *our* apiKey is bad. Don't pass it through: to
    // decker a 401 means its own signature was rejected.
    if (upstream.status === 401) {
      console.error(
        `[chatty ${reqId}] sync: OpenAI rejected the apiKey for promptId=${promptId} body=${text}`
      );
      return fail(res, reqId, 502, "OpenAI rejected the proxy's apiKey for this prompt");
    }
    // Otherwise OpenAI's response is forwarded unchanged so decker parses it
    // as before.
    res
      .status(upstream.status)
      .type(upstream.headers.get("content-type") || "application/json")
      .send(text);
  }
);

app.use(express.json()); // parse JSON bodies

// Session-log store. Opened unconditionally (cheap) so every sealed turn is
// recorded; the admin UI that reads it back is mounted separately below and is
// only enabled when a cookieSecret is configured.
const store = openDb(config.dbPath || "./chatty.db");

// Build the row for one proxied turn and persist it. Wrapped so a logging
// failure can never break the proxy path — the turn is best-effort telemetry,
// not part of the response contract. `logCtx` is null on the legacy path (those
// prompt ids are OpenAI's, not our selectors, and have no admin to read them).
function recordTurn(logCtx, reqId, terminalEvent) {
  if (!logCtx) return;
  try {
    const row = extractLogFields({
      reqId,
      promptId: logCtx.promptId,
      input: logCtx.input,
      previous_response_id: logCtx.previous_response_id,
      terminalEvent,
    });
    store.insertTurn(row, new Date().toISOString());
  } catch (err) {
    console.error(`[chatty ${reqId}] failed to write session log: ${err.message}`);
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// Short id to correlate the handful of log lines belonging to one request,
// and to give the client something to hand back to an admin ("ref: xxxx")
// so a report of "the bot broke" can be found in journalctl right away.
function newReqId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Send a pre-stream error: logged in full server-side, but the client only
// ever sees a short public message plus the ref id — never raw exception
// text, which could (via decrypted-payload JSON.parse failures) contain
// fragments of a sealed instructions blob.
function fail(res, reqId, status, publicMessage) {
  return res.status(status).send(`${publicMessage} (ref: ${reqId})`);
}

// Write a synthetic SSE "error" event using the same event shape OpenAI
// itself uses, so chatty.js's existing `case "error"` handler renders it.
// Used when the stream breaks after headers/200 have already gone out, so a
// plain HTTP error response is no longer possible.
function writeStreamError(res, reqId, message) {
  if (res.writableEnded) return;
  const evt = { type: "error", error: { message: `${message} (ref: ${reqId})` } };
  res.write(`data: ${JSON.stringify(evt)}\n\n`);
}

// Scan one SSE "data: {...}" line and log the parts worth knowing about
// without ever touching output text or echoed instructions on the console.
// OpenAI's Responses API returns HTTP 200 even when the run ultimately fails,
// so the only way to see a quota/model/tool error is to look inside the stream.
// Returns the parsed event object when it is a terminal event (the run reached
// an end state), otherwise null — the caller keeps the last one to log the turn
// to the session store, where output text and usage are captured in full.
function parseTerminalEvent(reqId, line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return null;
  }
  switch (evt.type) {
    case "error":
      console.error(
        `[chatty ${reqId}] stream error code=${evt.error?.code} message=${evt.error?.message}`
      );
      return evt;
    case "response.failed":
      console.error(
        `[chatty ${reqId}] response.failed code=${evt.response?.error?.code} message=${evt.response?.error?.message}`
      );
      return evt;
    case "response.incomplete":
      console.warn(
        `[chatty ${reqId}] response.incomplete reason=${evt.response?.incomplete_details?.reason}`
      );
      return evt;
    case "response.completed":
      console.log(
        `[chatty ${reqId}] response.completed usage=${JSON.stringify(evt.response?.usage)}`
      );
      return evt;
    default:
      return null;
  }
}

// Stream an OpenAI Responses SSE reply back to the client. `logCtx`, when
// provided (sealed path only), carries the request fields needed to record the
// turn to the session store at every terminal point below.
async function streamUpstream(res, apiKey, body, reqId, logCtx) {
  console.log(
    `[chatty ${reqId}] calling OpenAI model=${body.model ?? "(default)"}`
  );

  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[chatty ${reqId}] failed to reach OpenAI: ${err.message}`);
    recordTurn(logCtx, reqId, {
      type: "error",
      error: { message: "could not reach OpenAI" },
    });
    return fail(res, reqId, 502, "could not reach OpenAI");
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    const authHint =
      upstream.status === 401 || upstream.status === 403
        ? " (likely a wrong/revoked apiKey for this prompt)"
        : "";
    console.error(
      `[chatty ${reqId}] upstream HTTP error status=${upstream.status}${authHint} body=${text}`
    );
    recordTurn(logCtx, reqId, {
      type: "error",
      error: { code: upstream.status, message: `upstream HTTP ${upstream.status}` },
    });
    // OpenAI's own error body already names the problem (bad key, bad
    // model, rate limit, ...) so it's forwarded as-is; the ref id is
    // prepended so an admin can jump straight to the matching log lines.
    return res
      .status(upstream.status)
      .send(`(ref: ${reqId}) ${text || "Upstream error"}`);
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let terminalEvent = null;

  try {
    for await (const chunk of upstream.body) {
      bytes += chunk.length;
      res.write(chunk);

      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const evt = parseTerminalEvent(reqId, data);
        if (evt) terminalEvent = evt;
      }
    }
  } catch (err) {
    // Connection to OpenAI dropped mid-stream. Headers are already sent, so
    // this can only be surfaced as an in-band SSE error event.
    console.error(`[chatty ${reqId}] stream interrupted: ${err.message}`);
    recordTurn(logCtx, reqId, {
      type: "error",
      error: { message: "connection to OpenAI was interrupted" },
    });
    writeStreamError(res, reqId, "connection to OpenAI was interrupted");
    return res.end();
  }

  console.log(
    `[chatty ${reqId}] stream done bytes=${bytes} terminalEventSeen=${!!terminalEvent}`
  );

  // The stream closed without a completed/failed/error/incomplete event.
  // That's exactly the silent-failure shape that's easy to miss: HTTP 200,
  // but the client never got a real answer or a reason why.
  if (!terminalEvent) {
    console.warn(`[chatty ${reqId}] stream ended without a terminal event`);
    writeStreamError(res, reqId, "upstream stream ended without completing");
  }

  // Record the turn (terminalEvent may be null → status "unknown").
  recordTurn(logCtx, reqId, terminalEvent);

  res.end();
}

app.post("/chatty", async (req, res) => {
  const reqId = newReqId();
  try {
    const { promptId, sealed, prompt, input, previous_response_id, stream } =
      req.body || {};

    // Sealed path (new decks): the model, system prompt and vector store all
    // come from the encrypted blob; client overrides are ignored.
    if (sealed) {
      console.log(`[chatty ${reqId}] sealed request promptId=${promptId}`);
      const entry = prompts[promptId];
      if (!entry) {
        console.warn(`[chatty ${reqId}] unknown promptId=${promptId}`);
        return fail(res, reqId, 400, `unknown promptId: ${promptId}`);
      }

      let payload;
      try {
        payload = openConfig(entry.deckConfigKey, promptId, sealed);
      } catch (e) {
        // Covers tampering, wrong key, and blob/prompt-id mismatch. GCM auth
        // failures all look the same, so this is most likely a deckConfigKey
        // that doesn't match the author's chatty-key.json for this prompt.
        console.warn(
          `[chatty ${reqId}] invalid sealed config promptId=${promptId} reason=${e.message} (check deckConfigKey for this prompt)`
        );
        return fail(res, reqId, 400, "invalid sealed config");
      }

      console.log(
        `[chatty ${reqId}] decrypted promptId=${promptId} model=${payload.model} vector_store_id=${payload.vector_store_id}`
      );

      const body = buildUpstreamBody(payload, {
        input,
        previous_response_id,
        stream,
      });
      const logCtx = { promptId, input, previous_response_id };
      return await streamUpstream(res, entry.apiKey, body, reqId, logCtx);
    }

    // Legacy path (old decks, no sealed blob): forward the stored-prompt request
    // to OpenAI as-is, using the top-level fallback apiKey. The prompt.id is an
    // OpenAI stored-prompt id resolved by OpenAI, not one of our selectors, so
    // it is deliberately not looked up in `prompts`. This keeps already-
    // published decks working until OpenAI removes stored prompts.
    if (prompt?.id) {
      console.log(`[chatty ${reqId}] legacy request prompt.id=${prompt.id}`);
      if (!config.apiKey) {
        console.warn(
          `[chatty ${reqId}] legacy stored-prompt request but no top-level apiKey configured`
        );
        return fail(
          res,
          reqId,
          400,
          "legacy stored-prompt request but no top-level apiKey configured"
        );
      }
      const body = { stream: true, ...req.body };
      return await streamUpstream(res, config.apiKey, body, reqId);
    }

    console.warn(`[chatty ${reqId}] missing sealed config or prompt id`);
    return fail(res, reqId, 400, "missing sealed config or prompt id");
  } catch (err) {
    console.error(`[chatty ${reqId}] unhandled error: ${err.stack || err}`);
    if (!res.headersSent) {
      fail(res, reqId, 500, "internal proxy error");
    } else {
      writeStreamError(res, reqId, "internal proxy error");
      res.end();
    }
  }
});

// Admin UI for inspecting session logs. Mounted under a configurable path
// prefix (default /chatty/admin) and only enabled when a cookieSecret is set,
// since that secret signs the login cookie. Behind a Caddy `handle_path` that
// strips the public prefix, the app is reached at the mount path directly.
const adminMountPath = config.adminMountPath || "/chatty/admin";
const adminRouter = createAdminRouter({
  prompts,
  store,
  cookieSecret: config.cookieSecret,
  mountPath: adminMountPath,
  // Secure cookie by default (production is HTTPS via Caddy). Set
  // config.cookieSecure=false only for local plain-HTTP testing.
  cookieSecure: config.cookieSecure !== false,
});
if (adminRouter) {
  app.use(adminMountPath, adminRouter);
  console.log(`[chatty] admin UI mounted at ${adminMountPath}`);
} else {
  console.log("[chatty] admin UI disabled (set config.cookieSecret to enable)");
}

// Catches malformed request bodies (bad JSON, oversized payloads, wrong
// Content-Type) raised by express.json() before they reach the route.
app.use((err, req, res, _next) => {
  const reqId = newReqId();
  console.warn(
    `[chatty ${reqId}] malformed request: ${err.message} type=${err.type ?? "unknown"}`
  );
  fail(res, reqId, 400, "malformed request");
});

const port = process.env.PORT || config.port || 3000;
app.listen(port, () => console.log(`Proxy on http://localhost:${port}`));
