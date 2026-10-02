import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXIT_KINDS, type Exit, type ExitCount } from "../shared/exits.ts";
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
`;

let db: DatabaseSync | null = null;

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
  } catch (err) {
    console.error(`could not record exit: ${(err as Error).message}`);
  }
}

/** Exits in the last `days` days, by kind and section, most used first. */
export function exitCounts(days: number, now = new Date()): ExitCount[] {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  return open()
    .prepare(
      `SELECT kind, COALESCE(section, '') AS section, COUNT(*) AS count FROM exits
       WHERE at >= ? GROUP BY kind, COALESCE(section, '') ORDER BY count DESC, kind, section`,
    )
    .all(since) as unknown as ExitCount[];
}
