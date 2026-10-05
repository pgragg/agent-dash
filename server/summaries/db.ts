import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { splitSummary } from "../../shared/nextSteps.ts";
import type { Diagram, DiagramKind, NextStep, Note, ThreadStatus, ThreadStatusChange, TicketSummary } from "../../shared/types.ts";

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

-- One row per numbered step of a finished summary, written when the summary is saved.
CREATE TABLE IF NOT EXISTS next_steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_id INTEGER NOT NULL REFERENCES summaries (id),
  ticket     TEXT NOT NULL,
  position   INTEGER NOT NULL,
  body       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS next_steps_by_summary ON next_steps (summary_id, position);

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

-- One row per action on the Actions view, from it first showing to it going away.
-- key names what the action is about ("ci_failing pr:<url>"), so the same action keeps its row and age.
CREATE TABLE IF NOT EXISTS actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  ticket     TEXT,
  created_at TEXT NOT NULL,
  cleared_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS actions_open_by_key ON actions (key) WHERE cleared_at IS NULL;

-- One row per diagram an agent made. It keeps the source, so the diagram outlives its log and its file.
-- key is "<session_id> <hash>": the same diagram twice in one conversation is one row.
-- hash stays the agent's own, so its fence in a message still finds an edited row.
-- A deleted row stays, with deleted_at, so the next scan of its log does not add it again.
CREATE TABLE IF NOT EXISTS diagrams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  ticket     TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('mermaid', 'svg', 'png', 'jpeg', 'gif', 'webp')),
  title      TEXT NOT NULL,
  origin     TEXT NOT NULL,
  hash       TEXT NOT NULL,
  source     TEXT NOT NULL, -- mermaid or SVG text, or base64 for a raster image
  created_at TEXT NOT NULL,
  edited_at  TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS diagrams_by_ticket ON diagrams (ticket, id);
CREATE INDEX IF NOT EXISTS diagrams_by_session ON diagrams (session_id, id);
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
    steps: r.status === "done" ? stepsFor(r.id) : [],
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
  const diagramColumns = new Set((db.prepare("PRAGMA table_info(diagrams)").all() as { name: string }[]).map((c) => c.name));
  for (const c of ["edited_at", "deleted_at"]) if (!diagramColumns.has(c)) db.exec(`ALTER TABLE diagrams ADD COLUMN ${c} TEXT`);
  // Summaries saved before steps were stored get their rows once.
  for (const r of db.prepare("SELECT id, ticket, summary FROM summaries WHERE status = 'done' AND id NOT IN (SELECT summary_id FROM next_steps)").all() as unknown as Row[]) {
    insertSteps(r.id, r.ticket, r.summary ?? "");
  }
  return db;
}

const STEP_COLUMNS = "id, summary_id AS summaryId, ticket, position, body";

function insertSteps(id: number, ticket: string, summary: string): void {
  const insert = open().prepare("INSERT INTO next_steps (summary_id, ticket, position, body) VALUES (?, ?, ?, ?)");
  splitSummary(summary).steps.forEach((body, i) => insert.run(id, ticket, i + 1, body));
}

export function stepsFor(summaryId: number): NextStep[] {
  return (open().prepare(`SELECT ${STEP_COLUMNS} FROM next_steps WHERE summary_id = ? ORDER BY position`).all(summaryId) as unknown as NextStep[]).map((s) => ({ ...s }));
}

export function getStep(id: number): NextStep | null {
  const row = open().prepare(`SELECT ${STEP_COLUMNS} FROM next_steps WHERE id = ?`).get(id) as unknown as NextStep | undefined;
  return row ? { ...row } : null;
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
  const d = open();
  d.exec("BEGIN IMMEDIATE");
  try {
    const row = d
      .prepare("UPDATE summaries SET status = 'done', summary = ?, generated_at = ?, error = NULL WHERE id = ? AND status = 'in_progress' RETURNING ticket")
      .get(summary, now.toISOString(), id) as { ticket: string } | undefined;
    if (row) insertSteps(id, row.ticket, summary);
    d.exec("COMMIT");
    return !!row;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
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

// ---- actions: what to do next, with the time each one first showed ---------------------

export interface ActionKey {
  key: string;
  kind: string;
  ticket: string | null;
  /** When the action really started, if that is older than now: a next step dates from its summary. */
  createdAt?: string;
}

/**
 * Opens a row for each new key, and clears each open row whose key is gone, unless `keepMissing`
 * says its source could not be read. It writes only on a change, because each write to the
 * database reloads the page, which calls this again.
 */
export function syncActions(current: ActionKey[], keepMissing: (key: string) => boolean = () => false, now = new Date()): Map<string, { id: number; createdAt: string }> {
  const d = open();
  const rows = d.prepare("SELECT id, key, created_at AS createdAt FROM actions WHERE cleared_at IS NULL").all() as unknown as { id: number; key: string; createdAt: string }[];
  const byKey = new Map(rows.map((r) => [r.key, { id: r.id, createdAt: r.createdAt }]));
  const wanted = new Set(current.map((a) => a.key));
  const added = current.filter((a) => !byKey.has(a.key));
  const gone = rows.filter((r) => !wanted.has(r.key) && !keepMissing(r.key));
  if (!added.length && !gone.length) return byKey;

  d.exec("BEGIN IMMEDIATE");
  try {
    const insert = d.prepare("INSERT INTO actions (key, kind, ticket, created_at) VALUES (?, ?, ?, ?) RETURNING id, created_at AS createdAt");
    for (const a of added) {
      if (byKey.has(a.key)) continue; // The same key twice in one call.
      const row = insert.get(a.key, a.kind, a.ticket, a.createdAt ?? now.toISOString()) as { id: number; createdAt: string };
      byKey.set(a.key, { id: row.id, createdAt: row.createdAt });
    }
    const clear = d.prepare("UPDATE actions SET cleared_at = ? WHERE id = ?");
    for (const r of gone) {
      clear.run(now.toISOString(), r.id);
      byKey.delete(r.key);
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  return byKey;
}

// ---- diagrams: the diagrams and charts that agents made ------------------------------

const DIAGRAM_COLUMNS = "id, kind, title, session_id AS sessionId, ticket, origin, hash, created_at AS createdAt, edited_at AS editedAt";

export interface NewDiagram {
  key: string;
  sessionId: string;
  ticket: string | null;
  kind: DiagramKind;
  title: string;
  origin: string;
  hash: string;
  source: string;
  createdAt: string;
}

export function diagramKeys(): Set<string> {
  return new Set((open().prepare("SELECT key FROM diagrams").all() as { key: string }[]).map((r) => r.key));
}

/** One transaction, so the first scan of every old log reloads the page once. */
export function addDiagrams(rows: NewDiagram[]): void {
  if (!rows.length) return;
  const d = open();
  const insert = d.prepare("INSERT OR IGNORE INTO diagrams (key, session_id, ticket, kind, title, origin, hash, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  d.exec("BEGIN IMMEDIATE");
  try {
    for (const r of rows) insert.run(r.key, r.sessionId, r.ticket, r.kind, r.title, r.origin, r.hash, r.source, r.createdAt);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

/** Newest first, without the source or the deleted ones. */
export function listDiagrams(): Diagram[] {
  return (open().prepare(`SELECT ${DIAGRAM_COLUMNS} FROM diagrams WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC`).all() as unknown as Diagram[]).map((r) => ({ ...r }));
}

export type StoredDiagram = Diagram & { source: string | null; deletedAt: string | null };

/** A deleted one too, so its page can restore it. Without `raw`, raster base64 stays put: the page loads the image as a file. */
export function getDiagram(id: number, raw = false): StoredDiagram | null {
  const source = raw ? "source" : "CASE WHEN kind IN ('mermaid', 'svg') THEN source END AS source";
  const row = open().prepare(`SELECT ${DIAGRAM_COLUMNS}, deleted_at AS deletedAt, ${source} FROM diagrams WHERE id = ?`).get(id) as unknown as StoredDiagram | undefined;
  return row ? { ...row } : null;
}

/** Your fix for an agent's mistake. The caller checks that the source fits the kind. */
export function updateDiagram(id: number, change: { title?: string; source?: string; deleted?: boolean }, now = new Date()): boolean {
  const at = now.toISOString();
  const sets: [string, string | null][] = [];
  if (change.title !== undefined) sets.push(["title", change.title]);
  if (change.source !== undefined) sets.push(["source", change.source]);
  if (sets.length) sets.push(["edited_at", at]);
  if (change.deleted !== undefined) sets.push(["deleted_at", change.deleted ? at : null]);
  if (!sets.length) return false;
  return Number(open().prepare(`UPDATE diagrams SET ${sets.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...sets.map(([, v]) => v), id).changes) > 0;
}

/** A conversation can get its ticket later, from a PR that names one. */
export function setDiagramTicket(sessionId: string, ticket: string): number {
  return Number(open().prepare("UPDATE diagrams SET ticket = ? WHERE session_id = ? AND ticket IS NOT ?").run(ticket, sessionId, ticket).changes);
}

export function inProgress(): SummaryRecord[] {
  return (open().prepare("SELECT * FROM summaries WHERE status = 'in_progress'").all() as unknown as Row[]).map(toRecord);
}
