import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db.mjs";

function baseRow(over = {}) {
  return {
    req_id: "r",
    prompt_id: "p1",
    response_id: null,
    previous_response_id: null,
    model: "gpt-5",
    input_text: "hi",
    output_text: "hello",
    usage_json: null,
    status: "completed",
    error_message: null,
    ...over,
  };
}

test("first turn starts a session, follow-up inherits it via response chain", () => {
  const store = openDb(":memory:");

  const sA = store.insertTurn(
    baseRow({ response_id: "resp_1", input_text: "q1" }),
    "2026-01-01T10:00:00.000Z"
  );
  // Follow-up replies to resp_1 -> same session.
  const sA2 = store.insertTurn(
    baseRow({ response_id: "resp_2", previous_response_id: "resp_1", input_text: "q2" }),
    "2026-01-01T10:01:00.000Z"
  );
  assert.equal(sA2, sA);

  // A brand new first turn -> different session.
  const sB = store.insertTurn(
    baseRow({ response_id: "resp_3", input_text: "other" }),
    "2026-01-01T10:02:00.000Z"
  );
  assert.notEqual(sB, sA);

  const sessions = store.listSessions("p1");
  assert.equal(sessions.length, 2);
  const bySession = Object.fromEntries(sessions.map((s) => [s.session_id, s]));
  assert.equal(bySession[sA].turn_count, 2);
  assert.equal(bySession[sB].turn_count, 1);
  store.close();
});

test("follow-up to an unknown parent starts a fresh session (not dropped)", () => {
  const store = openDb(":memory:");
  const s = store.insertTurn(
    baseRow({ response_id: "x", previous_response_id: "does_not_exist" }),
    "2026-01-01T10:00:00.000Z"
  );
  assert.ok(s);
  assert.equal(store.countSessions("p1"), 1);
  store.close();
});

test("session list preview is the first turn's input, newest session first", () => {
  const store = openDb(":memory:");
  store.insertTurn(baseRow({ response_id: "a1", input_text: "first Q" }), "2026-01-01T10:00:00.000Z");
  store.insertTurn(
    baseRow({ response_id: "a2", previous_response_id: "a1", input_text: "second Q" }),
    "2026-01-01T10:05:00.000Z"
  );
  store.insertTurn(baseRow({ response_id: "b1", input_text: "newer session Q" }), "2026-01-01T11:00:00.000Z");

  const sessions = store.listSessions("p1");
  assert.equal(sessions[0].preview, "newer session Q"); // most recent activity first
  const older = sessions.find((s) => s.turn_count === 2);
  assert.equal(older.preview, "first Q"); // first input, not the follow-up
  store.close();
});

test("queries are scoped by prompt id", () => {
  const store = openDb(":memory:");
  store.insertTurn(baseRow({ prompt_id: "p1", response_id: "p1a" }), "2026-01-01T10:00:00.000Z");
  store.insertTurn(baseRow({ prompt_id: "p2", response_id: "p2a" }), "2026-01-01T10:00:00.000Z");

  assert.equal(store.countSessions("p1"), 1);
  assert.equal(store.countSessions("p2"), 1);
  assert.equal(store.listSessions("p1").length, 1);

  // A p1 admin cannot read p2's session even with the right session id.
  const p2Session = store.listSessions("p2")[0].session_id;
  assert.equal(store.getSessionTurns("p1", p2Session).length, 0);
  store.close();
});

test("getSessionTurns returns turns oldest-first", () => {
  const store = openDb(":memory:");
  const s = store.insertTurn(baseRow({ response_id: "t1", input_text: "one" }), "2026-01-01T10:00:00.000Z");
  store.insertTurn(
    baseRow({ response_id: "t2", previous_response_id: "t1", input_text: "two" }),
    "2026-01-01T10:01:00.000Z"
  );
  const turns = store.getSessionTurns("p1", s);
  assert.deepEqual(turns.map((t) => t.input_text), ["one", "two"]);
  store.close();
});

test("deleteSession and deleteBefore are prompt-scoped", () => {
  const store = openDb(":memory:");
  const s1 = store.insertTurn(baseRow({ response_id: "s1" }), "2026-01-01T10:00:00.000Z");
  store.insertTurn(baseRow({ response_id: "s2" }), "2026-06-01T10:00:00.000Z");
  store.insertTurn(baseRow({ prompt_id: "p2", response_id: "o1" }), "2026-01-01T10:00:00.000Z");

  assert.equal(store.deleteSession("p1", s1), 1);
  assert.equal(store.countSessions("p1"), 1);

  // Deleting p1 history before a cutoff must not touch p2.
  store.deleteBefore("p1", "2027-01-01T00:00:00.000Z");
  assert.equal(store.countSessions("p1"), 0);
  assert.equal(store.countSessions("p2"), 1);
  store.close();
});

test("error turns are logged too (status preserved)", () => {
  const store = openDb(":memory:");
  const s = store.insertTurn(
    baseRow({ response_id: "e1", status: "failed", output_text: null, error_message: "boom" }),
    "2026-01-01T10:00:00.000Z"
  );
  const [turn] = store.getSessionTurns("p1", s);
  assert.equal(turn.status, "failed");
  assert.equal(turn.error_message, "boom");
  const [session] = store.listSessions("p1");
  assert.equal(session.error_count, 1);
  store.close();
});
