// Session-log store for the chatty proxy.
//
// Uses Node's built-in synchronous SQLite (node:sqlite, stable in Node ≥ 22.5),
// so there is no native build step and no extra dependency. A "session" is a
// conversation thread: turns are linked by OpenAI's response-id chain. The
// proxy is otherwise stateless, so the session id is reconstructed here at
// insert time from `previous_response_id` (see insertTurn).
//
// Never store secrets: no api keys and no decrypted `instructions`. The admin
// who inspects these logs already authored the instructions, so re-storing them
// would only add risk. Input text, output text and usage are the point of the
// feature and are stored in full.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id                   INTEGER PRIMARY KEY,
  req_id               TEXT,
  prompt_id            TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  response_id          TEXT,
  previous_response_id TEXT,
  created_at           TEXT NOT NULL,   -- ISO8601 UTC
  model                TEXT,
  input_text           TEXT,
  output_text          TEXT,
  usage_json           TEXT,
  status               TEXT,            -- completed | failed | incomplete | error | unknown
  error_message        TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_prompt_session
  ON turns (prompt_id, session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_turns_response
  ON turns (response_id);
`;

// Open (creating if needed) the session-log database at `path` and ensure the
// schema exists. Returns an object of prepared-statement-backed helpers so the
// route handlers never touch SQL directly. Pass ":memory:" in tests.
export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return makeApi(db);
}

function makeApi(db) {
  const stmtSessionForResponse = db.prepare(
    "SELECT session_id FROM turns WHERE response_id = ? LIMIT 1"
  );
  const stmtInsert = db.prepare(`
    INSERT INTO turns
      (req_id, prompt_id, session_id, response_id, previous_response_id,
       created_at, model, input_text, output_text, usage_json, status, error_message)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // One row per proxied turn. `row` is what logging.extractLogFields produced,
  // minus the session bookkeeping, which is resolved here:
  //   - a turn with no previous_response_id starts a new session;
  //   - a follow-up inherits the session of the turn it replies to;
  //   - if that parent predates logging (not found), we still start a fresh
  //     session so the turn is never dropped.
  // `now` is injected (ISO string) to keep this deterministic under test.
  function insertTurn(row, now) {
    let sessionId = null;
    if (row.previous_response_id) {
      const parent = stmtSessionForResponse.get(row.previous_response_id);
      if (parent) sessionId = parent.session_id;
    }
    if (!sessionId) sessionId = crypto.randomUUID();

    stmtInsert.run(
      row.req_id ?? null,
      row.prompt_id,
      sessionId,
      row.response_id ?? null,
      row.previous_response_id ?? null,
      now,
      row.model ?? null,
      row.input_text ?? null,
      row.output_text ?? null,
      row.usage_json ?? null,
      row.status ?? null,
      row.error_message ?? null
    );
    return sessionId;
  }

  // Sessions for one prompt, newest activity first, with a first-message
  // preview and turn count for the list view. Scoped to prompt_id — an admin
  // only ever sees their own prompt's traffic.
  const stmtListSessions = db.prepare(`
    SELECT
      session_id,
      COUNT(*)                       AS turn_count,
      MIN(created_at)                AS started_at,
      MAX(created_at)                AS last_at,
      MAX(model)                     AS model,
      SUM(CASE WHEN status NOT IN ('completed') THEN 1 ELSE 0 END) AS error_count
    FROM turns
    WHERE prompt_id = ?
    GROUP BY session_id
    ORDER BY last_at DESC
    LIMIT ? OFFSET ?
  `);
  const stmtFirstInput = db.prepare(`
    SELECT input_text FROM turns
    WHERE prompt_id = ? AND session_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `);
  function listSessions(promptId, { limit = 50, offset = 0 } = {}) {
    const rows = stmtListSessions.all(promptId, limit, offset);
    for (const r of rows) {
      const first = stmtFirstInput.get(promptId, r.session_id);
      r.preview = first?.input_text ?? "";
    }
    return rows;
  }

  const stmtCountSessions = db.prepare(
    "SELECT COUNT(DISTINCT session_id) AS n FROM turns WHERE prompt_id = ?"
  );
  function countSessions(promptId) {
    return stmtCountSessions.get(promptId).n;
  }

  // All turns of one session, oldest first, for the transcript view. Scoped to
  // prompt_id so a guessed session id from another prompt returns nothing.
  const stmtSessionTurns = db.prepare(`
    SELECT id, req_id, response_id, previous_response_id, created_at, model,
           input_text, output_text, usage_json, status, error_message
    FROM turns
    WHERE prompt_id = ? AND session_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  function getSessionTurns(promptId, sessionId) {
    return stmtSessionTurns.all(promptId, sessionId);
  }

  // Purge helpers — wired for a future admin UI (deferred). Both are scoped to
  // prompt_id so one admin can never delete another prompt's logs.
  const stmtDeleteSession = db.prepare(
    "DELETE FROM turns WHERE prompt_id = ? AND session_id = ?"
  );
  function deleteSession(promptId, sessionId) {
    return stmtDeleteSession.run(promptId, sessionId).changes;
  }
  const stmtDeleteBefore = db.prepare(
    "DELETE FROM turns WHERE prompt_id = ? AND created_at < ?"
  );
  function deleteBefore(promptId, isoCutoff) {
    return stmtDeleteBefore.run(promptId, isoCutoff).changes;
  }

  return {
    db,
    insertTurn,
    listSessions,
    countSessions,
    getSessionTurns,
    deleteSession,
    deleteBefore,
    close: () => db.close(),
  };
}
