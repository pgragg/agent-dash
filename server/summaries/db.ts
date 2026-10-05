import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { splitSummary } from "../../shared/nextSteps.ts";
import type { Diagram, DiagramKind, NextStep, Note, ReviewDraft, SdlcEnvironment, SdlcEvent, SdlcEventType, SmoketestOutcome, ThreadStatus, ThreadStatusChange, TicketSummary } from "../../shared/types.ts";

export const DB_PATH = process.env.AGENT_DASH_DB ?? join(homedir(), ".agent-dash/agent-dash.db");

const THREAD_TABLE = `
CREATE TABLE IF NOT EXISTS PiConversationStatusChange (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('relevant', 'resolved', 'unlinked')),
  reason     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_conversation_status_by_thread ON PiConversationStatusChange (ticket, session_id, id);
`;

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
${THREAD_TABLE}

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

-- One row per thing that happened to a change on its way to prod: a smoketest, a deploy that
-- Argo or Piper confirmed, or a Slack message that asked for a PR review. The other SDLC stages
-- read GitHub and Jira, so they have no rows.
CREATE TABLE IF NOT EXISTS SDLC_Event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL CHECK (event_type IN ('smoketest', 'deploy', 'review_request')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  outcome      TEXT CHECK (outcome IN ('passed', 'failed', 'blocked')),
  test_details TEXT,
  test_results TEXT,
  -- The pi session that runs the smoketest, when agent-dash started it, so the page can link to it.
  session_id   TEXT,
  -- Set when Piper chose not to run the smoketest: the stage then counts as passed by on purpose.
  skipped_at   TEXT,
  created_at   TEXT NOT NULL,
  -- One line that the agent writes when the smoketest is done, for the collapsed row on the page.
  summary      TEXT,
  -- A review request: the PR, the Slack channel id, the text that was posted, and its permalink.
  pr_url       TEXT,
  channel      TEXT,
  message      TEXT,
  message_url  TEXT
);

-- The environments under test, usually one.
CREATE TABLE IF NOT EXISTS SDLC_Event_Environment (
  sdlc_event_id INTEGER NOT NULL REFERENCES SDLC_Event (id),
  environment   TEXT NOT NULL CHECK (environment IN ('localhost', 'fern_dev', 'fern_prod', 'postman_beta', 'postman_prod')),
  PRIMARY KEY (sdlc_event_id, environment)
);

CREATE TABLE IF NOT EXISTS SDLC_Event_Ticket (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sdlc_event_id INTEGER NOT NULL REFERENCES SDLC_Event (id),
  ticket        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  -- Set when the server started a next-steps draft for this link; empty means not yet.
  summary_requested_at TEXT,
  -- When the event last changed after it was made; empty if it never did.
  changed_at    TEXT,
  UNIQUE (sdlc_event_id, ticket)
);
CREATE INDEX IF NOT EXISTS sdlc_event_ticket_by_ticket ON SDLC_Event_Ticket (ticket);

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

-- Local state per ticket. Jira stays the source of truth for everything else about it.
-- snoozed_until hides the ticket from the board until that time. starred_at pins it to the top.
CREATE TABLE IF NOT EXISTS tickets (
  key           TEXT PRIMARY KEY,
  snoozed_until TEXT,
  starred_at    TEXT
);

-- One drafted Slack review request per PR, written by a cheap model. Piper can edit it before it is sent.
CREATE TABLE IF NOT EXISTS review_drafts (
  pr_url       TEXT PRIMARY KEY,
  status       TEXT NOT NULL CHECK (status IN ('in_progress', 'done', 'failed')),
  text         TEXT,
  error        TEXT,
  requested_at TEXT NOT NULL
);
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

const SDLC_EVENT_COLUMNS = ["session_id", "skipped_at", "pr_url", "channel", "message", "message_url", "summary"];

/** SQLite cannot change a CHECK, so an older SDLC_Event table is copied into a new one with the same ids. */
function upgradeSdlcEventChecks(d: DatabaseSync): void {
  const row = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'SDLC_Event'").get() as { sql: string } | undefined;
  if (!row || (row.sql.includes("'blocked'") && row.sql.includes("'review_request'"))) return;
  const create = SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS SDLC_Event ("), SCHEMA.indexOf("-- The environments under test"));
  const cols = ["id, event_type, started_at, finished_at, outcome, test_details, test_results, created_at", ...SDLC_EVENT_COLUMNS].join(", ");
  // The other SDLC tables refer to SDLC_Event by name, so the checks must be off while it is gone.
  d.exec("PRAGMA foreign_keys = OFF");
  try {
    d.exec(`BEGIN;
${create.replace("SDLC_Event (", "SDLC_Event_new (")}
INSERT INTO SDLC_Event_new (${cols}) SELECT ${cols} FROM SDLC_Event;
DROP TABLE SDLC_Event;
ALTER TABLE SDLC_Event_new RENAME TO SDLC_Event;
COMMIT;`);
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  } finally {
    d.exec("PRAGMA foreign_keys = ON");
  }
}

export function open(path = DB_PATH): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  // WAL lets the server read while a summary run writes from its own process. The timeout comes
  // first, so a write from another process makes the WAL switch wait instead of crash the server.
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  const diagramColumns = new Set((db.prepare("PRAGMA table_info(diagrams)").all() as { name: string }[]).map((c) => c.name));
  for (const c of ["edited_at", "deleted_at"]) if (!diagramColumns.has(c)) db.exec(`ALTER TABLE diagrams ADD COLUMN ${c} TEXT`);
  // CREATE TABLE IF NOT EXISTS does not add a column to a table that is already there.
  for (const c of SDLC_EVENT_COLUMNS) if (!db.prepare("SELECT 1 FROM pragma_table_info('SDLC_Event') WHERE name = ?").get(c)) db.exec(`ALTER TABLE SDLC_Event ADD COLUMN ${c} TEXT`);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('tickets') WHERE name = 'starred_at'").get()) db.exec("ALTER TABLE tickets ADD COLUMN starred_at TEXT");
  // Before the trigger below: copying the table drops the triggers on it.
  upgradeSdlcEventChecks(db);
  // SQLite cannot change a CHECK, so an older table is copied into one that allows 'unlinked'.
  const threadTable = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'PiConversationStatusChange'").get() as { sql: string };
  if (!threadTable.sql.includes("'unlinked'")) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE PiConversationStatusChange RENAME TO PiConversationStatusChange_old;
      DROP INDEX pi_conversation_status_by_thread;
      ${THREAD_TABLE}
      INSERT INTO PiConversationStatusChange SELECT * FROM PiConversationStatusChange_old;
      DROP TABLE PiConversationStatusChange_old;
      COMMIT;`);
  }
  // Links that are already there count as drafted, so an upgrade does not start a paid run per ticket.
  if (!(db.prepare("SELECT 1 FROM pragma_table_info('SDLC_Event_Ticket') WHERE name = 'summary_requested_at'").get())) {
    db.exec("ALTER TABLE SDLC_Event_Ticket ADD COLUMN summary_requested_at TEXT; UPDATE SDLC_Event_Ticket SET summary_requested_at = created_at");
  }
  if (!(db.prepare("SELECT 1 FROM pragma_table_info('SDLC_Event_Ticket') WHERE name = 'changed_at'").get())) db.exec("ALTER TABLE SDLC_Event_Ticket ADD COLUMN changed_at TEXT");
  // A changed event needs a new draft too. A trigger catches every writer, also the script's own process.
  db.exec(`CREATE TRIGGER IF NOT EXISTS sdlc_event_changed AFTER UPDATE ON SDLC_Event BEGIN
    UPDATE SDLC_Event_Ticket SET summary_requested_at = NULL, changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE sdlc_event_id = NEW.id;
  END`);
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

// ---- snooze: hide a ticket from the board until a time ---------------------------------

/** `until` null wakes the ticket. */
export function setSnoozedUntil(ticket: string, until: Date | null): void {
  open()
    .prepare("INSERT INTO tickets (key, snoozed_until) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET snoozed_until = excluded.snoozed_until")
    .run(ticket, until?.toISOString() ?? null);
}

/** Every ticket's snooze, past ones too: the page compares them with its own clock. */
export function snoozedUntilByTicket(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of open().prepare("SELECT key, snoozed_until AS until FROM tickets WHERE snoozed_until IS NOT NULL").all() as { key: string; until: string }[]) out[r.key] = r.until;
  return out;
}

// ---- star: pin a ticket to the top of the board and the PRs view ----------------------

export function setStarred(ticket: string, starred: boolean): void {
  open()
    .prepare("INSERT INTO tickets (key, starred_at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET starred_at = excluded.starred_at")
    .run(ticket, starred ? new Date().toISOString() : null);
}

/** Starred ticket keys, first starred first. */
export function starredTickets(): string[] {
  return (open().prepare("SELECT key FROM tickets WHERE starred_at IS NOT NULL ORDER BY starred_at").all() as { key: string }[]).map((r) => r.key);
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

/** Newest first, without the source. Without `withDeleted`, without the ones you deleted. */
export function listDiagrams({ withDeleted = false } = {}): Diagram[] {
  return (open().prepare(`SELECT ${DIAGRAM_COLUMNS} FROM diagrams ${withDeleted ? "" : "WHERE deleted_at IS NULL"} ORDER BY created_at DESC, id DESC`).all() as unknown as Diagram[]).map((r) => ({ ...r }));
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

/** Drops a conversation's diagrams from file writes that a newer write of the same file replaced. Your edit is yours, so it stays. */
export function dropReplacedDiagrams(sessionId: string, keep: Set<string>): number {
  const rows = open().prepare("SELECT key FROM diagrams WHERE session_id = ? AND origin != 'reply' AND kind IN ('mermaid', 'svg') AND edited_at IS NULL").all(sessionId) as { key: string }[];
  const del = open().prepare("DELETE FROM diagrams WHERE key = ?");
  let n = 0;
  for (const r of rows) if (!keep.has(r.key)) n += Number(del.run(r.key).changes);
  return n;
}

/** A conversation can get its ticket later, from a PR that names one. */
export function setDiagramTicket(sessionId: string, ticket: string): number {
  return Number(open().prepare("UPDATE diagrams SET ticket = ? WHERE session_id = ? AND ticket IS NOT ?").run(ticket, sessionId, ticket).changes);
}

export function inProgress(): SummaryRecord[] {
  return (open().prepare("SELECT * FROM summaries WHERE status = 'in_progress'").all() as unknown as Row[]).map(toRecord);
}

// ---- SDLC events: smoketests and confirmed deploys, linked to tickets ------------------

export interface NewSdlcEvent {
  eventType: SdlcEventType;
  startedAt: string;
  finishedAt?: string | null;
  outcome?: SdlcEvent["outcome"];
  testDetails?: string | null;
  testResults?: string | null;
  sessionId?: string | null;
  skippedAt?: string | null;
  summary?: string | null;
  prUrl?: string | null;
  channel?: string | null;
  message?: string | null;
  messageUrl?: string | null;
  environments: SdlcEnvironment[];
  tickets: string[];
}

export function addSdlcEvent(e: NewSdlcEvent, now = new Date()): SdlcEvent {
  const d = open();
  const created = now.toISOString();
  d.exec("BEGIN IMMEDIATE");
  try {
    const { id } = d
      .prepare("INSERT INTO SDLC_Event (event_type, started_at, finished_at, outcome, test_details, test_results, session_id, skipped_at, created_at, pr_url, channel, message, message_url, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .get(e.eventType, e.startedAt, e.finishedAt ?? null, e.outcome ?? null, e.testDetails ?? null, e.testResults ?? null, e.sessionId ?? null, e.skippedAt ?? null, created, e.prUrl ?? null, e.channel ?? null, e.message ?? null, e.messageUrl ?? null, e.summary ?? null) as { id: number };
    const env = d.prepare("INSERT OR IGNORE INTO SDLC_Event_Environment (sdlc_event_id, environment) VALUES (?, ?)");
    for (const x of e.environments) env.run(id, x);
    // A smoketest that only started moves no stage yet, so it gets its draft when it finishes.
    const drafted = e.sessionId && !e.finishedAt && !e.outcome && !e.skippedAt ? created : null;
    const link = d.prepare("INSERT OR IGNORE INTO SDLC_Event_Ticket (sdlc_event_id, ticket, created_at, summary_requested_at) VALUES (?, ?, ?, ?)");
    for (const t of e.tickets) link.run(id, t, created, drafted);
    d.exec("COMMIT");
    return sdlcEvents("WHERE e.id = ?", id)[0];
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

export interface SdlcFinish {
  finishedAt: string;
  outcome: SmoketestOutcome;
  testDetails: string | null;
  testResults: string | null;
  summary?: string | null;
}

/** Ends a running smoketest. Null when there is no such smoketest, or it already ended. */
export function finishSdlcEvent(id: number, f: SdlcFinish): SdlcEvent | null {
  const changed = open()
    .prepare("UPDATE SDLC_Event SET finished_at = ?, outcome = ?, test_details = coalesce(?, test_details), test_results = coalesce(?, test_results), summary = coalesce(?, summary) WHERE id = ? AND event_type = 'smoketest' AND finished_at IS NULL AND outcome IS NULL AND skipped_at IS NULL")
    .run(f.finishedAt, f.outcome, f.testDetails, f.testResults, f.summary ?? null, id).changes;
  return changed ? getSdlcEvent(id) : null;
}

export function getSdlcEvent(id: number): SdlcEvent | null {
  return sdlcEvents("WHERE e.id = ?", id)[0] ?? null;
}

export function deleteSdlcEvent(id: number): boolean {
  const d = open();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare("DELETE FROM SDLC_Event_Environment WHERE sdlc_event_id = ?").run(id);
    d.prepare("DELETE FROM SDLC_Event_Ticket WHERE sdlc_event_id = ?").run(id);
    const gone = d.prepare("DELETE FROM SDLC_Event WHERE id = ?").run(id).changes > 0;
    d.exec("COMMIT");
    return gone;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

/** Newest first. `where` is a fixed clause from this file, never from a request. */
function sdlcEvents(where = "", ...params: number[]): SdlcEvent[] {
  const rows = open()
    .prepare(
      `SELECT e.id, e.event_type AS eventType, e.started_at AS startedAt, e.finished_at AS finishedAt, e.outcome, e.test_details AS testDetails, e.test_results AS testResults, e.session_id AS sessionId, e.skipped_at AS skippedAt, e.created_at AS createdAt,
        e.pr_url AS prUrl, e.channel, e.message, e.message_url AS messageUrl, e.summary,
        (SELECT group_concat(environment) FROM SDLC_Event_Environment WHERE sdlc_event_id = e.id) AS envs,
        (SELECT group_concat(ticket) FROM SDLC_Event_Ticket WHERE sdlc_event_id = e.id) AS keys
       FROM SDLC_Event e ${where} ORDER BY e.started_at DESC, e.id DESC`,
    )
    .all(...params) as unknown as (Omit<SdlcEvent, "environments" | "tickets"> & { envs: string | null; keys: string | null })[];
  return rows.map(({ envs, keys, ...r }) => ({ ...r, environments: (envs?.split(",") ?? []) as SdlcEnvironment[], tickets: keys?.split(",") ?? [] }));
}

/**
 * Marks every event link that has no next-steps draft yet as drafted, and returns its tickets,
 * with the newest time that an event was made or changed. Read and mark are one step, so two
 * callers never both draft.
 */
export function claimNewEventTickets(now = new Date()): Map<string, string> {
  const rows = open()
    .prepare("UPDATE SDLC_Event_Ticket SET summary_requested_at = ? WHERE summary_requested_at IS NULL RETURNING ticket, coalesce(changed_at, created_at) AS at")
    .all(now.toISOString()) as { ticket: string; at: string }[];
  const out = new Map<string, string>();
  for (const r of rows) {
    const prev = out.get(r.ticket);
    if (!prev || r.at > prev) out.set(r.ticket, r.at);
  }
  return out;
}

export function hasNewEventTickets(): boolean {
  return !!open().prepare("SELECT 1 FROM SDLC_Event_Ticket WHERE summary_requested_at IS NULL LIMIT 1").get();
}

/** Every ticket's events, newest first. An event on two tickets shows under both. */
export function sdlcEventsByTicket(): Record<string, SdlcEvent[]> {
  const out: Record<string, SdlcEvent[]> = {};
  for (const e of sdlcEvents()) for (const t of e.tickets) (out[t] ??= []).push(e);
  return out;
}

/** Every PR's review requests, newest first, also for PRs with no ticket. */
export function reviewRequestsByPr(): Record<string, SdlcEvent[]> {
  const out: Record<string, SdlcEvent[]> = {};
  for (const e of sdlcEvents("WHERE e.event_type = 'review_request'")) if (e.prUrl) (out[e.prUrl] ??= []).push(e);
  return out;
}

// ---- review drafts: a cheap model's Slack review request per PR -----------------------

const DRAFT_COLUMNS = "pr_url AS prUrl, status, text, error, requested_at AS requestedAt";

/**
 * Marks each PR that needs a draft as in progress, and returns those PRs. A PR needs one when it
 * has none, or its draft failed or got stuck before `retryBefore`. Read and mark are one step, so
 * two page loads never draft the same PR twice.
 */
export function claimReviewDrafts(prUrls: string[], retryBefore: string, now = new Date()): string[] {
  const claim = open().prepare(
    `INSERT INTO review_drafts (pr_url, status, requested_at) VALUES (?, 'in_progress', ?)
     ON CONFLICT (pr_url) DO UPDATE SET status = 'in_progress', error = NULL, requested_at = excluded.requested_at
     WHERE review_drafts.status != 'done' AND review_drafts.requested_at < ?
     RETURNING pr_url`,
  );
  return prUrls.filter((u) => claim.get(u, now.toISOString(), retryBefore));
}

/** Only an in-progress draft changes, so a late answer cannot overwrite a newer one. */
export function finishReviewDraft(prUrl: string, result: { text: string } | { error: string }): boolean {
  const text = "text" in result ? result.text : null;
  const error = "error" in result ? result.error : null;
  return open().prepare("UPDATE review_drafts SET status = ?, text = ?, error = ? WHERE pr_url = ? AND status = 'in_progress'").run(text ? "done" : "failed", text, error, prUrl).changes > 0;
}

export function deleteReviewDraft(prUrl: string): boolean {
  return open().prepare("DELETE FROM review_drafts WHERE pr_url = ?").run(prUrl).changes > 0;
}

export function reviewDrafts(): Record<string, ReviewDraft> {
  const out: Record<string, ReviewDraft> = {};
  for (const r of open().prepare(`SELECT ${DRAFT_COLUMNS} FROM review_drafts`).all() as unknown as ReviewDraft[]) out[r.prUrl] = { ...r };
  return out;
}
