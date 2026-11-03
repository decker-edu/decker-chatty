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

// Text of one input item (a string or a message item with string / content-part
// content). Non-text parts (e.g. input_image) are skipped. null if no text.
function itemText(item) {
  if (typeof item === "string") return item;
  const content = item?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (typeof c === "string") parts.push(c);
      else if (typeof c?.text === "string") parts.push(c.text);
    }
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

// Split what the deck sent into the student's own question and the context the
// deck adds around it. Decker's chatty.js sends an array whose *last* item is
// the typed question and whose earlier items describe the deck and current
// slide ("I am watching slide deck …", whiteboard annotations). Showing those
// in the question bubble repeats the same boilerplate on every turn, so they
// are kept apart as `context`. A plain string is all question.
export function splitInput(input) {
  if (input == null) return { question: null, context: null };
  if (typeof input === "string") return { question: input, context: null };
  if (!Array.isArray(input) || input.length === 0) {
    return { question: null, context: null };
  }
  const question = itemText(input[input.length - 1]);
  const ctx = input
    .slice(0, -1)
    .map(itemText)
    .filter((t) => t != null);
  return { question, context: ctx.length ? ctx.join("\n") : null };
}

// Rows logged before splitInput existed hold the whole array joined by "\n",
// starting with decker's fixed context sentences. Peel those off for display
// so old transcripts read the same as new ones. Text that doesn't start with
// decker's preamble is returned unchanged as the question.
const LEGACY_DECK_LINE = /^I am watching slide deck ".*$/;
const LEGACY_ANNOT_LINES = [
  /^The current slide does not contain hand-written annotations\.$/,
  /^In addition to the content from .* the current slide also contains additional hand-written annotations or drawings that are provided in the following image\.$/,
];
export function splitStoredInput(text) {
  if (typeof text !== "string") return { question: text ?? null, context: null };
  const lines = text.split("\n");
  if (!LEGACY_DECK_LINE.test(lines[0])) return { question: text, context: null };
  let n = 1;
  if (lines.length > 1 && LEGACY_ANNOT_LINES.some((re) => re.test(lines[1]))) n = 2;
  return {
    question: lines.slice(n).join("\n"),
    context: lines.slice(0, n).join("\n"),
  };
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
  const { question, context } = splitInput(input);
  const row = {
    req_id: reqId ?? null,
    prompt_id: promptId,
    previous_response_id: previous_response_id ?? null,
    response_id: null,
    model: null,
    input_text: question,
    context_text: context,
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
