import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import * as db from "../server/summaries/db.ts";

test("an older thread table that allows no 'unlinked' is copied into one that does, with its rows", () => {
  const path = join(mkdtempSync(join(tmpdir(), "agent-dash-test-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE PiConversationStatusChange (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL, session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('relevant', 'resolved')), reason TEXT, created_at TEXT NOT NULL);
  CREATE INDEX pi_conversation_status_by_thread ON PiConversationStatusChange (ticket, session_id, id);
  INSERT INTO PiConversationStatusChange (ticket, session_id, status, reason, created_at) VALUES ('FSDK-1', 'sess-0001', 'resolved', 'old reason', '2026-10-01T00:00:00.000Z');`);
  old.close();

  db.open(path);
  db.setThreadStatus("FSDK-1", "sess-0002", "unlinked", null);
  assert.deepEqual(db.currentThreadStatuses().map((t) => [t.sessionId, t.status, t.reason]), [["sess-0001", "resolved", "old reason"], ["sess-0002", "unlinked", null]]);
});
