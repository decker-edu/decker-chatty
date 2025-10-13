// npm init -y
// npm install express cors
// node server.js

import express from "express";
import cors from "cors";

import config from "./config.json" with {type: "json"};

const app = express();
app.use(cors()); // relax or remove in production
app.use(express.json()); // parse JSON bodies

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/chatty", async (req, res) => {
  try {
    //     const apiKey = process.env.OPENAI_API_KEY;
    //     if (!apiKey) return res.status(500).send("OPENAI_API_KEY not set");
    const apiKey = config.apiKey;

    // Ensure streaming is on unless the client overrides it
    const body = { stream: true, ...req.body };

    // Call OpenAI Responses API (streams Server-Sent Events)
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
      return res.status(upstream.status).send(text || "Upstream error");
    }

    // Pass through the SSE stream as-is
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send("Proxy error");
  }
});

const port = process.env.PORT || config.port || 3000;
app.listen(port, () => console.log(`Proxy on http://localhost:${port}`));
