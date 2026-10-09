import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXIT_KINDS, type Exit, type ExitCount, type Usage } from "../shared/exits.ts";
// Same file as the summaries; a second connection is safe in WAL mode.
import { DB_PATH } from "./summaries/db.ts";

const SCHEMA = `
-- Append-only: one row per time the developer left the dash for another tool.
CREATE TABLE IF NOT EXISTS exits (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN (${EXIT_KINDS.map((k) => `'${k}'`).join(", ")})),
  host    TEXT,
  view    TEXT,
  section TEXT,
  ticket  TEXT
);
CREATE INDEX IF NOT EXISTS exits_by_at ON exits (at);
-- Append-only: one row per view open or queue control click. Its own table, so exits.kind keeps its CHECK.
CREATE TABLE IF NOT EXISTS usage (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('view', 'control')),
  name   TEXT NOT NULL,
  ticket TEXT
);
`;

let db: DatabaseSync | null = null;
let lastWrite = 0;

export function open(path = DB_PATH): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/** Never throws: a lost count must not fail the action that caused it. */
export function recordExit(e: Exit, now = new Date()): void {
  try {
    open()
      .prepare("INSERT INTO exits (at, kind, host, view, section, ticket) VALUES (?, ?, ?, ?, ?, ?)")
      .run(now.toISOString(), e.kind, e.host, e.view, e.section, e.ticket);
    lastWrite = Date.now();
  } catch (err) {
    console.error(`could not record exit: ${(err as Error).message}`);
  }
}

/** Never throws, for the same reason as `recordExit`. */
export function recordUsage(u: Usage, now = new Date()): void {
  try {
    open().prepare("INSERT INTO usage (at, kind, name, ticket) VALUES (?, ?, ?, ?)").run(now.toISOString(), u.kind, u.name, u.ticket);
    lastWrite = Date.now();
  } catch (err) {
    console.error(`could not record usage: ${(err as Error).message}`);
  }
}

/** True just after an exit or usage row was saved, so the DB watcher can skip a page refresh it does not need. */
export function wroteRecently(ms = 1000): boolean {
  return Date.now() - lastWrite < ms;
}

/** Exits in the last `days` days, by kind and section, most used first. */
export function exitCounts(days: number, now = new Date()): ExitCount[] {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  return open()
    .prepare(
      `SELECT kind, COALESCE(section, '') AS section, COUNT(*) AS count FROM exits
       WHERE at >= ? GROUP BY kind, COALESCE(section, '') ORDER BY count DESC, kind, section`,
    )
    .all(since)
    .map((r) => ({ ...r }) as unknown as ExitCount);
}
