// npm init -y
// npm install express cors
// node server.js

import express from "express";
import cors from "cors";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

import config from "./config.json" with {type: "json"};

const app = express();
// app.use(cors()); // relax or remove in production
app.use(express.json()); // parse JSON bodies

// Parse SSE stream to extract data events
function parseSSE(text) {
  const events = [];
  const lines = text.split('\n');
  let currentEvent = {};

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6); // Remove 'data: ' prefix
      if (data === '[DONE]') {
        events.push('[DONE]');
      } else {
        try {
          currentEvent.data = JSON.parse(data);
          events.push(currentEvent.data);
          currentEvent = {};
        } catch (e) {
          // If JSON parse fails, store as raw string
          currentEvent.data = data;
          events.push(data);
          currentEvent = {};
        }
      }
    } else if (line.startsWith('event: ')) {
      currentEvent.event = line.slice(7);
    } else if (line.startsWith('id: ')) {
      currentEvent.id = line.slice(4);
    }
  }

  return events;
}

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

    // Collect chunks for logging
    const chunks = [];
    for await (const chunk of upstream.body) {
      chunks.push(chunk);
      res.write(chunk);
    }
    res.end();

    // Write log file if logging is enabled
    if (config.enableLogging) {
      const timestamp = new Date().toISOString();
      const filename = timestamp.replace(/:/g, "-").replace(/\..+Z$/, "") + ".json";
      const logPath = join("log", filename);
      const rawText = Buffer.concat(chunks).toString("utf-8");
      const events = parseSSE(rawText);
      const completedEvent = events.find(e => e?.type === "response.completed");
      const logData = {
        timestamp,
        request: req.body,
        response: completedEvent.response.output.find((o) => o.type === "message"),
      };
      await writeFile(logPath, JSON.stringify(logData, null, 2));
      console.log(`Logged to ${logPath}`);
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Proxy error");
  }
});

// Create log directory on startup if logging is enabled
if (config.enableLogging) {
  await mkdir("log", { recursive: true });
}

const port = process.env.PORT || config.port || 3000;
app.listen(port, () => console.log(`Proxy on http://localhost:${port}`));
