import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Note, ThreadStatus, ThreadStatusChange, TicketSummary } from "../../shared/types.ts";

export const DB_PATH = process.env.AGENT_DASH_DB ?? join(homedir(), ".agent-dash/agent-dash.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('in_progress', 'done', 'failed')),
  requested_at TEXT NOT NULL,
  generated_at TEXT,
  summary      TEXT,
  error        TEXT,
  pid          INTEGER,
  work_dir     TEXT
);
CREATE INDEX IF NOT EXISTS summaries_by_ticket ON summaries (ticket, id DESC);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_by_ticket ON notes (ticket, id);

-- Append-only: each row is one change; the newest row per (ticket, session_id) is the current state.
CREATE TABLE IF NOT EXISTS PiConversationStatusChange (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('relevant', 'resolved')),
  reason     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_conversation_status_by_thread ON PiConversationStatusChange (ticket, session_id, id);
`;

interface Row {
  id: number;
  ticket: string;
  status: TicketSummary["status"];
  requested_at: string;
  generated_at: string | null;
  summary: string | null;
  error: string | null;
  pid: number | null;
  work_dir: string | null;
}

export interface SummaryRecord extends TicketSummary {
  pid: number | null;
  workDir: string | null;
}

function toRecord(r: Row): SummaryRecord {
  return {
    id: r.id,
    ticket: r.ticket,
    status: r.status,
    requestedAt: r.requested_at,
    generatedAt: r.generated_at,
    summary: r.summary,
    error: r.error,
    pid: r.pid,
    workDir: r.work_dir,
  };
}

let db: DatabaseSync | null = null;

export function open(path = DB_PATH): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  // WAL lets the server read while a summary run writes from its own process.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export function createRequest(ticket: string, now = new Date()): SummaryRecord {
  const row = open()
    .prepare("INSERT INTO summaries (ticket, status, requested_at) VALUES (?, 'in_progress', ?) RETURNING *")
    .get(ticket, now.toISOString()) as unknown as Row;
  return toRecord(row);
}

export function setProcess(id: number, pid: number, workDir: string): void {
  open().prepare("UPDATE summaries SET pid = ?, work_dir = ? WHERE id = ?").run(pid, workDir, id);
}

/** Only an in-progress row changes, so a late write cannot overwrite a newer outcome. */
export function markDone(id: number, summary: string, now = new Date()): boolean {
  const res = open()
    .prepare("UPDATE summaries SET status = 'done', summary = ?, generated_at = ?, error = NULL WHERE id = ? AND status = 'in_progress'")
    .run(summary, now.toISOString(), id);
  return res.changes > 0;
}

export function markFailed(id: number, error: string): boolean {
  const res = open().prepare("UPDATE summaries SET status = 'failed', error = ? WHERE id = ? AND status = 'in_progress'").run(error, id);
  return res.changes > 0;
}

export function get(id: number): SummaryRecord | null {
  const row = open().prepare("SELECT * FROM summaries WHERE id = ?").get(id) as unknown as Row | undefined;
  return row ? toRecord(row) : null;
}

export function latestForTicket(ticket: string): SummaryRecord | null {
  const row = open().prepare("SELECT * FROM summaries WHERE ticket = ? ORDER BY id DESC LIMIT 1").get(ticket) as unknown as Row | undefined;
  return row ? toRecord(row) : null;
}

/** Per ticket: the newest request of any status, and the newest finished summary. */
export function summariesByTicket(): Map<string, { latest: SummaryRecord; lastDone: SummaryRecord | null }> {
  const d = open();
  const latest = d.prepare("SELECT * FROM summaries WHERE id IN (SELECT max(id) FROM summaries GROUP BY ticket)").all() as unknown as Row[];
  const done = d.prepare("SELECT * FROM summaries WHERE id IN (SELECT max(id) FROM summaries WHERE status = 'done' GROUP BY ticket)").all() as unknown as Row[];
  const doneBy = new Map(done.map((r) => [r.ticket, toRecord(r)]));
  return new Map(latest.map((r) => [r.ticket, { latest: toRecord(r), lastDone: doneBy.get(r.ticket) ?? null }]));
}

// ---- notes: private, timestamped notes on a ticket ------------------------------------

export function addNote(ticket: string, body: string, now = new Date()): Note {
  return open().prepare("INSERT INTO notes (ticket, created_at, body) VALUES (?, ?, ?) RETURNING id, ticket, created_at AS createdAt, body").get(ticket, now.toISOString(), body) as unknown as Note;
}

export function deleteNote(id: number): boolean {
  return open().prepare("DELETE FROM notes WHERE id = ?").run(id).changes > 0;
}

/** Oldest first. */
export function notesForTicket(ticket: string): Note[] {
  return open().prepare("SELECT id, ticket, created_at AS createdAt, body FROM notes WHERE ticket = ? ORDER BY id").all(ticket) as unknown as Note[];
}

/** Every ticket's notes, oldest first. */
export function notesByTicket(): Record<string, Note[]> {
  const out: Record<string, Note[]> = {};
  for (const n of open().prepare("SELECT id, ticket, created_at AS createdAt, body FROM notes ORDER BY id").all() as unknown as Note[]) {
    (out[n.ticket] ??= []).push({ ...n });
  }
  return out;
}

// ---- thread status: is a pi thread still relevant to a ticket? -----------------------

const THREAD_COLUMNS = "id, ticket, session_id AS sessionId, status, reason, created_at AS createdAt";

export function setThreadStatus(ticket: string, sessionId: string, status: ThreadStatus, reason: string | null, now = new Date()): ThreadStatusChange {
  return {
    ...(open()
      .prepare(`INSERT INTO PiConversationStatusChange (ticket, session_id, status, reason, created_at) VALUES (?, ?, ?, ?, ?) RETURNING ${THREAD_COLUMNS}`)
      .get(ticket, sessionId, status, status === "resolved" ? reason : null, now.toISOString()) as unknown as ThreadStatusChange),
  };
}

/** The current state of every (ticket, thread) pair that has ever changed. */
export function currentThreadStatuses(): ThreadStatusChange[] {
  return (
    open()
      .prepare(`SELECT ${THREAD_COLUMNS} FROM PiConversationStatusChange WHERE id IN (SELECT max(id) FROM PiConversationStatusChange GROUP BY ticket, session_id)`)
      .all() as unknown as ThreadStatusChange[]
  ).map((r) => ({ ...r }));
}

export function threadHistory(ticket: string, sessionId: string): ThreadStatusChange[] {
  return (open().prepare(`SELECT ${THREAD_COLUMNS} FROM PiConversationStatusChange WHERE ticket = ? AND session_id = ? ORDER BY id`).all(ticket, sessionId) as unknown as ThreadStatusChange[]).map((r) => ({ ...r }));
}

export function inProgress(): SummaryRecord[] {
  return (open().prepare("SELECT * FROM summaries WHERE status = 'in_progress'").all() as unknown as Row[]).map(toRecord);
}
