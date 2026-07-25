// npm install express cors
// node server.mjs

import express from "express";
import cors from "cors";

import config from "./config.json" with { type: "json" };
import { loadPrompts, openConfig, buildUpstreamBody } from "./seal.mjs";

const app = express();
app.use(cors()); // relax or remove in production
app.use(express.json()); // parse JSON bodies

// Decode and validate every deck-config key at startup (fail fast).
let prompts;
try {
  prompts = loadPrompts(config);
} catch (err) {
  console.error(`[chatty] fatal: invalid config.json: ${err.message}`);
  process.exit(1);
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
// without ever touching output text or echoed instructions. OpenAI's
// Responses API returns HTTP 200 even when the run ultimately fails, so the
// only way to see a quota/model/tool error is to look inside the stream.
// Returns true if this was a terminal event (the run reached an end state).
function logStreamEvent(reqId, line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return false;
  }
  switch (evt.type) {
    case "error":
      console.error(
        `[chatty ${reqId}] stream error code=${evt.error?.code} message=${evt.error?.message}`
      );
      return true;
    case "response.failed":
      console.error(
        `[chatty ${reqId}] response.failed code=${evt.response?.error?.code} message=${evt.response?.error?.message}`
      );
      return true;
    case "response.incomplete":
      console.warn(
        `[chatty ${reqId}] response.incomplete reason=${evt.response?.incomplete_details?.reason}`
      );
      return true;
    case "response.completed":
      console.log(
        `[chatty ${reqId}] response.completed usage=${JSON.stringify(evt.response?.usage)}`
      );
      return true;
    default:
      return false;
  }
}

// Stream an OpenAI Responses SSE reply back to the client.
async function streamUpstream(res, apiKey, body, reqId) {
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
  let sawTerminalEvent = false;

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
        if (logStreamEvent(reqId, data)) sawTerminalEvent = true;
      }
    }
  } catch (err) {
    // Connection to OpenAI dropped mid-stream. Headers are already sent, so
    // this can only be surfaced as an in-band SSE error event.
    console.error(`[chatty ${reqId}] stream interrupted: ${err.message}`);
    writeStreamError(res, reqId, "connection to OpenAI was interrupted");
    return res.end();
  }

  console.log(
    `[chatty ${reqId}] stream done bytes=${bytes} terminalEventSeen=${sawTerminalEvent}`
  );

  // The stream closed without a completed/failed/error/incomplete event.
  // That's exactly the silent-failure shape that's easy to miss: HTTP 200,
  // but the client never got a real answer or a reason why.
  if (!sawTerminalEvent) {
    console.warn(`[chatty ${reqId}] stream ended without a terminal event`);
    writeStreamError(res, reqId, "upstream stream ended without completing");
  }

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
      return await streamUpstream(res, entry.apiKey, body, reqId);
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
