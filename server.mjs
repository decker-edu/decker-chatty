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
const prompts = loadPrompts(config);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Stream an OpenAI Responses SSE reply back to the client.
async function streamUpstream(res, apiKey, body) {
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    res.status(upstream.status).send(text || "Upstream error");
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

app.post("/chatty", async (req, res) => {
  try {
    const { promptId, sealed, prompt, input, previous_response_id, stream } =
      req.body || {};

    // Sealed path (new decks): the model, system prompt and vector store all
    // come from the encrypted blob; client overrides are ignored.
    if (sealed) {
      const entry = prompts[promptId];
      if (!entry) return res.status(400).send(`unknown promptId: ${promptId}`);

      let payload;
      try {
        payload = openConfig(entry.deckConfigKey, promptId, sealed);
      } catch (e) {
        // Covers tampering, wrong key, and blob/prompt-id mismatch.
        return res.status(400).send("invalid sealed config");
      }

      const body = buildUpstreamBody(payload, {
        input,
        previous_response_id,
        stream,
      });
      return await streamUpstream(res, entry.apiKey, body);
    }

    // Legacy path (old decks, no sealed blob): forward the stored-prompt request
    // as-is. Works until OpenAI removes stored prompts. The api key is taken
    // from the matching prompt entry.
    if (prompt?.id) {
      const entry = prompts[prompt.id];
      if (!entry) return res.status(400).send(`unknown prompt id: ${prompt.id}`);
      const body = { stream: true, ...req.body };
      return await streamUpstream(res, entry.apiKey, body);
    }

    return res.status(400).send("missing sealed config or prompt id");
  } catch (err) {
    console.error(err);
    res.status(500).send("Proxy error");
  }
});

const port = process.env.PORT || config.port || 3000;
app.listen(port, () => console.log(`Proxy on http://localhost:${port}`));
