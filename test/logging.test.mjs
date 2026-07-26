import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractInputText,
  extractOutputText,
  extractLogFields,
} from "../logging.mjs";

test("extractInputText: plain string passes through", () => {
  assert.equal(extractInputText("hello prof"), "hello prof");
});

test("extractInputText: array of message items with content parts", () => {
  const input = [
    { role: "user", content: [{ type: "input_text", text: "part one" }] },
    { role: "user", content: "part two" },
  ];
  assert.equal(extractInputText(input), "part one\npart two");
});

test("extractInputText: null / empty", () => {
  assert.equal(extractInputText(null), null);
  assert.equal(extractInputText([]), null);
});

test("extractOutputText: prefers aggregated output_text", () => {
  assert.equal(extractOutputText({ output_text: "answer" }), "answer");
});

test("extractOutputText: falls back to output content parts", () => {
  const response = {
    output: [
      { type: "reasoning", content: null },
      {
        type: "message",
        content: [
          { type: "output_text", text: "hello " },
          { type: "output_text", text: "world" },
        ],
      },
    ],
  };
  assert.equal(extractOutputText(response), "hello world");
});

test("extractLogFields: completed event captures output, usage, model, id", () => {
  const evt = {
    type: "response.completed",
    response: {
      id: "resp_123",
      model: "gpt-5",
      output_text: "the answer",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  };
  const row = extractLogFields({
    reqId: "abc",
    promptId: "prompt-x",
    input: "the question",
    previous_response_id: null,
    terminalEvent: evt,
  });
  assert.equal(row.status, "completed");
  assert.equal(row.response_id, "resp_123");
  assert.equal(row.model, "gpt-5");
  assert.equal(row.input_text, "the question");
  assert.equal(row.output_text, "the answer");
  assert.equal(JSON.parse(row.usage_json).total_tokens, 15);
  assert.equal(row.prompt_id, "prompt-x");
  assert.equal(row.req_id, "abc");
});

test("extractLogFields: failed event records error, no output", () => {
  const row = extractLogFields({
    promptId: "p",
    input: "q",
    terminalEvent: {
      type: "response.failed",
      response: { id: "resp_9", error: { code: "rate_limit", message: "slow down" } },
    },
  });
  assert.equal(row.status, "failed");
  assert.equal(row.error_message, "slow down");
  assert.equal(row.output_text, null);
  assert.equal(row.response_id, "resp_9");
});

test("extractLogFields: incomplete event records reason", () => {
  const row = extractLogFields({
    promptId: "p",
    input: "q",
    terminalEvent: {
      type: "response.incomplete",
      response: { id: "r", incomplete_details: { reason: "max_output_tokens" } },
    },
  });
  assert.equal(row.status, "incomplete");
  assert.equal(row.error_message, "max_output_tokens");
});

test("extractLogFields: standalone error event", () => {
  const row = extractLogFields({
    promptId: "p",
    input: "q",
    terminalEvent: { type: "error", error: { message: "boom" } },
  });
  assert.equal(row.status, "error");
  assert.equal(row.error_message, "boom");
  assert.equal(row.response_id, null);
});

test("extractLogFields: no terminal event -> status unknown, input still kept", () => {
  const row = extractLogFields({
    promptId: "p",
    input: "q",
    terminalEvent: null,
  });
  assert.equal(row.status, "unknown");
  assert.equal(row.input_text, "q");
  assert.equal(row.output_text, null);
});

test("extractLogFields: never stores instructions or keys", () => {
  const row = extractLogFields({
    promptId: "p",
    input: "q",
    terminalEvent: {
      type: "response.completed",
      response: { id: "r", instructions: "SECRET SYSTEM PROMPT", output_text: "a" },
    },
  });
  // Row shape is fixed; there is no field that could carry instructions.
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "error_message",
      "input_text",
      "model",
      "output_text",
      "previous_response_id",
      "prompt_id",
      "req_id",
      "response_id",
      "status",
      "usage_json",
    ].sort()
  );
  assert.ok(!JSON.stringify(row).includes("SECRET SYSTEM PROMPT"));
});
