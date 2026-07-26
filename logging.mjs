// Pure helpers that turn one proxied turn into a session-log row.
//
// Kept free of Express, SQLite and I/O so it is unit-testable in isolation
// (mirrors the seal.mjs discipline). The route handler feeds it the request
// fields it already has plus the *terminal* SSE event it saw, and gets back a
// flat row for db.insertTurn. It never sees or emits api keys or instructions.
//
// OpenAI Responses SSE terminal events we care about:
//   response.completed  -> { response: { id, model, output[], usage } }
//   response.failed     -> { response: { id, error: { code, message } } }
//   response.incomplete -> { response: { id, incomplete_details: { reason } } }
//   error               -> { error: { code, message } }   (no response object)

// The user's message. `input` is what the deck sent: usually a plain string,
// but the Responses API also accepts an array of message items, so pull text
// out of any user-role content parts as a fallback.
export function extractInputText(input) {
  if (input == null) return null;
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    const parts = [];
    for (const item of input) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      const content = item?.content;
      if (typeof content === "string") {
        parts.push(content);
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c === "string") parts.push(c);
          else if (typeof c?.text === "string") parts.push(c.text);
        }
      }
    }
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

// The assistant's answer text out of a completed `response` object. Prefer the
// aggregated `output_text` when present; otherwise concatenate the text of the
// output_text content parts across all message items, skipping tool calls and
// reasoning items.
export function extractOutputText(response) {
  if (!response) return null;
  if (typeof response.output_text === "string") return response.output_text;
  const output = response.output;
  if (!Array.isArray(output)) return null;
  const parts = [];
  for (const item of output) {
    if (!Array.isArray(item?.content)) continue;
    for (const c of item.content) {
      if (c?.type === "output_text" && typeof c.text === "string") {
        parts.push(c.text);
      }
    }
  }
  return parts.length ? parts.join("") : null;
}

// Build the row for db.insertTurn. `terminalEvent` is the parsed object of the
// last meaningful SSE event (or null if the stream ended without one — the
// silent-failure case the proxy already warns about). Session assignment is
// left to the db layer, which needs previous_response_id (passed through here).
export function extractLogFields({
  reqId,
  promptId,
  input,
  previous_response_id,
  terminalEvent,
}) {
  const row = {
    req_id: reqId ?? null,
    prompt_id: promptId,
    previous_response_id: previous_response_id ?? null,
    response_id: null,
    model: null,
    input_text: extractInputText(input),
    output_text: null,
    usage_json: null,
    status: "unknown",
    error_message: null,
  };

  const evt = terminalEvent;
  const resp = evt?.response;
  if (resp?.id) row.response_id = resp.id;
  if (typeof resp?.model === "string") row.model = resp.model;

  switch (evt?.type) {
    case "response.completed":
      row.status = "completed";
      row.output_text = extractOutputText(resp);
      if (resp?.usage) row.usage_json = JSON.stringify(resp.usage);
      break;
    case "response.failed":
      row.status = "failed";
      row.error_message = resp?.error?.message ?? resp?.error?.code ?? null;
      break;
    case "response.incomplete":
      row.status = "incomplete";
      row.error_message = resp?.incomplete_details?.reason ?? null;
      break;
    case "error":
      row.status = "error";
      row.error_message = evt.error?.message ?? evt.error?.code ?? null;
      break;
    default:
      // No terminal event seen: stream ended without completing.
      row.status = "unknown";
  }

  return row;
}
