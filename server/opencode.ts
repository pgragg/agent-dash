import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { permissionTitle } from "../shared/claudeDialog.ts";
import type { RunActivity, RunDialog } from "../shared/types.ts";
import { isAlive, type ReportedStatus } from "./sources/status.ts";

// A computed path: the extension imports pi's types, which this repo does not install for tsc.
const PI_EXTENSION = "../extension/agent-dash-status.ts";
/** The same one-line, secret-free tool summary as pi's and Claude Code's status files. */
const { summarizeTool } = (await import(PI_EXTENSION)) as { summarizeTool: (tool: string, args: unknown) => string };

/**
 * OpenCode 2 runs every session in one background service, and keeps them in SQLite. So the dash
 * talks to it in three ways, and needs no extension or hook in OpenCode:
 *
 * - The board reads the database, and writes each session as a pi log (`syncOpencodeLogs`).
 * - A poller asks the service which sessions run and which permission requests are open, and
 *   writes the same status files as pi's extension (`startOpencodeStatus`).
 * - Replies, Steer, Stop and permission answers go to the service's HTTP API.
 */

const run = promisify(execFile);

/** A one-turn draft or summary session: it is deleted at the end, and the board skips it meanwhile. */
export const ONESHOT_TITLE = "agent-dash one-shot";

/** OpenCode takes a session id from the client when it starts with "ses". */
export const newOpencodeSessionId = (): string => `ses_${randomUUID().replace(/-/g, "")}`;

// ---- the database, as pi logs -------------------------------------------------------

/** OpenCode's tool names, as pi has them, so one parser reads both logs. */
const TOOLS: Record<string, string> = { shell: "bash", glob: "find", patch: "edit", apply_patch: "edit", list: "ls" };
const STOPS: Record<string, string> = { stop: "stop", "tool-calls": "toolUse", length: "length", error: "error", "content-filter": "stop", unknown: "stop" };

export interface OpencodeSessionRow {
  id: string;
  directory: string;
  title: string | null;
  time_created: number;
}

export interface OpencodeMessageRow {
  type: string;
  data: string;
}

const iso = (ms: unknown): string | undefined => (typeof ms === "number" ? new Date(ms).toISOString() : undefined);
const toolName = (name: string): string => TOOLS[name] ?? name;

/**
 * One OpenCode session in pi's log shape: a session header (with `agent`), the title, and one
 * message per prompt, reply and tool result. A tool's result is part of the reply in OpenCode;
 * pi logs it as its own message after the reply.
 */
export function opencodeAsPiLog(session: OpencodeSessionRow, messages: OpencodeMessageRow[]): string {
  const out: unknown[] = [{ type: "session", id: session.id, cwd: session.directory, timestamp: iso(session.time_created), agent: "opencode" }];
  if (session.title) out.push({ type: "session_info", name: session.title });
  for (const row of messages) {
    let m: any;
    try {
      m = JSON.parse(row.data);
    } catch {
      continue;
    }
    const timestamp = iso(m.time?.created);
    if (row.type === "user") {
      out.push({ type: "message", timestamp, message: { role: "user", content: [{ type: "text", text: String(m.text ?? "") }] } });
    } else if (row.type === "skill") {
      // As Claude Code's Skill tool call, so a report skill unlinks the run as it does there.
      out.push({ type: "message", timestamp, message: { role: "assistant", content: [{ type: "toolCall", name: "Skill", arguments: { skill: m.name } }], stopReason: "toolUse" } });
    } else if (row.type === "model-switched" && m.model?.id) {
      out.push({ type: "model_change", modelId: m.model.id });
    } else if (row.type === "assistant") {
      const parts: any[] = Array.isArray(m.content) ? m.content : [];
      const content = parts.flatMap((p): unknown[] =>
        p?.type === "text" ? [{ type: "text", text: p.text }] : p?.type === "tool" ? [{ type: "toolCall", id: p.id, name: toolName(p.name), arguments: typeof p.state?.input === "object" ? p.state.input : {} }] : [],
      );
      // A reply without an end is still streaming or running its tools.
      const stopReason = m.finish ? (STOPS[m.finish] ?? "stop") : m.time?.completed ? "stop" : "toolUse";
      out.push({ type: "message", timestamp, message: { role: "assistant", model: m.model?.id ?? null, content, stopReason, ...(m.error ? { errorMessage: String(m.error.message ?? m.error._tag ?? "error") } : {}) } });
      for (const p of parts) {
        if (p?.type !== "tool" || (p.state?.status !== "completed" && p.state?.status !== "error")) continue;
        out.push({ type: "message", timestamp: iso(p.time?.completed) ?? timestamp, message: { role: "toolResult", toolCallId: p.id, content: p.state.content ?? [], isError: p.state.status === "error" } });
      }
    } else if (row.type === "idle" && m.outcome === "interrupted") {
      // pi logs a stop on the reply; OpenCode logs it on the idle marker.
      out.push({ type: "message", timestamp, message: { role: "assistant", content: [], stopReason: "aborted" } });
    }
  }
  return out.map((o) => JSON.stringify(o)).join("\n");
}

let handle: { file: string; db: DatabaseSync } | null = null;

/** Read-only, so the dash can never change OpenCode's data. WAL lets it read while OpenCode writes. */
function openDb(file: string): DatabaseSync | null {
  if (handle?.file === file) return handle.db;
  if (!existsSync(file)) return null;
  handle = { file, db: new DatabaseSync(file, { readOnly: true }) };
  return handle.db;
}

/** A folder per project, as pi and Claude Code have, from the session's folder. */
const projectFolder = (dir: string): string => dir.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "root";

/**
 * Write each top-level OpenCode session as a pi log in `outDir`, with the time of its newest
 * message as the file's mtime. A file whose mtime matches is not written again. Subagent sessions
 * are not the conversation, as Claude Code's sidechains are not.
 */
export function syncOpencodeLogs(dbFile: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const db = openDb(dbFile);
  if (!db) return;
  const rows = db
    .prepare(
      `select s.id, s.directory, s.title, s.time_created, max(s.time_updated, coalesce(max(m.time_updated), 0)) as stamp
       from session_v2 s left join session_message m on m.session_id = s.id
       where s.parent_id is null group by s.id`,
    )
    .all() as unknown as (OpencodeSessionRow & { stamp: number })[];
  const messages = db.prepare("select type, data from session_message where session_id = ? order by seq");
  const keep = new Set<string>();
  for (const s of rows) {
    if (s.title?.startsWith(ONESHOT_TITLE)) continue;
    const folder = join(outDir, projectFolder(s.directory));
    const file = join(folder, `${s.id}.jsonl`);
    keep.add(file);
    if (statSync(file, { throwIfNoEntry: false })?.mtimeMs === s.stamp) continue;
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${file}.tmp`, opencodeAsPiLog(s, messages.all(s.id) as unknown as OpencodeMessageRow[]));
    utimesSync(`${file}.tmp`, new Date(s.stamp), new Date(s.stamp));
    renameSync(`${file}.tmp`, file);
  }
  // A session that was deleted in OpenCode leaves the board too.
  for (const folder of readdirSync(outDir, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const f of readdirSync(join(outDir, folder.name))) {
      const file = join(outDir, folder.name, f);
      if (!keep.has(file)) rmSync(file, { force: true });
    }
  }
}

// ---- the service's HTTP API ---------------------------------------------------------

interface Registration {
  url: string;
  pid: number;
  password?: string;
}

/** The background service writes its address, pid and password here when it starts. */
const registrationFile = (): string => join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "opencode/service.json");

/** The running service, or null. It never starts one: a poll must not wake a service that you stopped. */
export function readRegistration(file = registrationFile()): Registration | null {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as Registration;
    return typeof r.url === "string" && typeof r.pid === "number" && isAlive(r.pid) ? r : null;
  } catch {
    return null;
  }
}

/** The service, started when it is not running: `opencode api` starts it and waits until it answers. */
async function service(): Promise<Registration> {
  const found = readRegistration();
  if (found) return found;
  await run("opencode", ["api", "server.info"], { timeout: 30_000 });
  const started = readRegistration();
  if (!started) throw new Error("the OpenCode service did not start: run `opencode service status`");
  return started;
}

/** One API call. `start`: start the service first when it is not running. */
export async function opencodeApi<T = unknown>(method: string, path: string, body?: unknown, opts: { start?: boolean } = { start: true }): Promise<T> {
  const reg = opts.start ? await service() : readRegistration();
  if (!reg) throw new Error("the OpenCode service is not running");
  const res = await fetch(`${reg.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(reg.password ? { authorization: `Basic ${Buffer.from(`opencode:${reg.password}`).toString("base64")}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenCode ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const sessionPath = (id: string): string => `/api/session/${encodeURIComponent(id)}`;

/** A message to a session. A steer reads it after the current tool calls; a queued one waits for the turn's end. An idle session starts on either. */
export async function opencodeSend(sessionId: string, text: string, steer = false): Promise<void> {
  await opencodeApi("POST", `${sessionPath(sessionId)}/prompt`, { text, delivery: steer ? "steer" : "queue" });
}

export async function opencodeInterrupt(sessionId: string): Promise<void> {
  await opencodeApi("POST", `${sessionPath(sessionId)}/interrupt`);
}

export async function opencodeAnswerPermission(sessionId: string, requestId: string, allow: boolean): Promise<void> {
  await opencodeApi("POST", `${sessionPath(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`, allow ? { decision: "once" } : { decision: "reject", message: "The user denied this tool call in agent-dash." });
}

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** Before a Bash or a write: ask on the page, as the Claude Code setup agent does. Reads and searches run. */
export const ASK_BEFORE_CHANGES: PermissionRule[] = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
];

/** Make a session in `cwd` with the id that the dash picked. The service starts if it is not running. */
export async function opencodeCreate(o: { sessionId: string; cwd: string; title?: string; model?: string; permissions?: PermissionRule[] }): Promise<void> {
  const [providerID, ...id] = (o.model ?? "").split("/");
  await opencodeApi("POST", "/api/session", {
    id: o.sessionId,
    location: { directory: o.cwd },
    ...(o.title ? { title: o.title } : {}),
    ...(id.length ? { model: { providerID, id: id.join("/") } } : {}),
    ...(o.permissions ? { permissions: o.permissions } : {}),
  });
}

// ---- status files -------------------------------------------------------------------

interface PermissionRequest {
  id: string;
  /** A subagent's own session, when the request is from one. */
  sessionID: string;
  action: string;
  resources: string[];
}

/** The dialog of a pending permission request, with what the server needs to answer only it. */
export type OpencodeDialog = RunDialog & { id: string; sessionID: string };

/** A pending permission request, as the confirm dialog that the page shows. */
export function permissionDialog(p: PermissionRequest, since: string): OpencodeDialog {
  const target = p.resources.join(", ");
  return { id: p.id, sessionID: p.sessionID, method: "confirm", title: permissionTitle(p.action, { command: target }), message: target.slice(0, 1000), since };
}

/** An idle session waits on you this long, as a pi log without a status file does; then it is finished. */
const IDLE_MS = 4 * 3600_000;

export interface OpencodeSnapshot {
  now: number;
  /** The service's pid: a status file with a dead pid reads as finished. */
  pid: number;
  /** Sessions that run now, with their open permission request and newest running tool. */
  active: Map<string, { dialog: OpencodeDialog | null; activity: RunActivity | null }>;
  /** Sessions whose last turn ended less than IDLE_MS ago: they wait on you, also from before the dash started. */
  recent: Set<string>;
  /** What the database says about each session in `active`, `recent` or `previous`. Missing: deleted. */
  sessions: Map<string, { cwd: string; idleAt: number | null; archived: boolean }>;
  /** The OpenCode status files from the last poll. */
  previous: Map<string, ReportedStatus>;
}

/**
 * The status files to write after one poll. A session gets a file when it runs or has just run,
 * then waits on you after its turn, and is closed after IDLE_MS, or when it is deleted or archived.
 * A closed session opens again when it runs. Only files that change are returned.
 */
export function opencodeStatusUpdates(s: OpencodeSnapshot): ReportedStatus[] {
  const nowIso = new Date(s.now).toISOString();
  const out: ReportedStatus[] = [];
  for (const id of new Set([...s.active.keys(), ...s.recent, ...s.previous.keys()])) {
    const old = s.previous.get(id);
    const live = s.active.get(id);
    const info = s.sessions.get(id);
    if (!live && old?.state === "closed") continue;
    if (!live && !old && !(s.recent.has(id) && info)) continue;
    const base: ReportedStatus = {
      ...old,
      sessionId: id,
      pid: s.pid,
      cwd: info?.cwd ?? old?.cwd,
      itermSessionId: null,
      agent: "opencode",
      // The service takes messages, Stop and answers for every session, also one in a terminal.
      inbox: true,
      version: 2,
      mode: "rpc",
      state: "working",
      since: nowIso,
      activity: null,
      dialog: null,
    };
    let next: ReportedStatus;
    if (live) {
      const dialog = live.dialog && old?.dialog && (old.dialog as { id?: string }).id === live.dialog.id ? old.dialog : live.dialog;
      next = { ...base, since: old?.state === "working" ? old.since : nowIso, activity: live.activity, dialog };
    } else if (!info || info.archived || (old?.state === "awaiting_input" && s.now - Date.parse(old.since) > IDLE_MS)) {
      next = { ...base, state: "closed", since: nowIso };
    } else {
      next = { ...base, state: "awaiting_input", since: old?.state === "awaiting_input" ? old.since : info.idleAt ? new Date(info.idleAt).toISOString() : nowIso };
    }
    if (JSON.stringify(next) !== JSON.stringify(old)) out.push(next);
  }
  return out;
}

function writeStatus(dir: string, s: ReportedStatus): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${s.sessionId}.json`);
  writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(s));
  renameSync(`${file}.${process.pid}.tmp`, file);
}

function readOpencodeStatuses(dir: string): Map<string, ReportedStatus> {
  const out = new Map<string, ReportedStatus>();
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (!f.startsWith("ses") || !f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as ReportedStatus;
      if (s.agent === "opencode") out.set(s.sessionId, s);
    } catch {
      // Mid-write; the next poll reads it.
    }
  }
  return out;
}

/** The newest tool call that still runs, from the session's newest reply. */
function runningTool(db: DatabaseSync | null, sessionId: string): RunActivity | null {
  const row = db?.prepare("select data from session_message where session_id = ? and type = 'assistant' order by seq desc limit 1").get(sessionId) as { data: string } | undefined;
  if (!row) return null;
  try {
    const tool = ((JSON.parse(row.data).content ?? []) as any[]).findLast((p) => p?.type === "tool" && p.state?.status === "running");
    if (!tool) return null;
    const name = toolName(tool.name);
    return { tool: name, summary: summarizeTool(name, tool.state.input), since: iso(tool.time?.ran ?? tool.time?.created) ?? new Date().toISOString() };
  } catch {
    return null;
  }
}

/** One poll: ask the service, read the database, and write the status files that changed. */
export async function pollOpencodeStatus(statusDir: string, dbFile: string, now = Date.now()): Promise<number> {
  const reg = readRegistration();
  // No service: every file's pid is dead, so the board shows the sessions as finished.
  if (!reg) return 0;
  const previous = readOpencodeStatuses(statusDir);
  const db = openDb(dbFile);
  const info = db?.prepare("select directory, title, time_idle, time_archived, parent_id from session_v2 where id = ?");
  const rows = new Map<string, { directory: string; title: string | null; time_idle: number | null; time_archived: number | null; parent_id: string | null }>();
  const row = (id: string) => {
    if (!rows.has(id)) rows.set(id, info?.get(id) as any);
    return rows.get(id);
  };
  const all = Object.keys((await opencodeApi<{ data: Record<string, unknown> }>("GET", "/api/session/active", undefined, { start: false })).data ?? {});
  // A subagent works for its parent, so its question shows on the parent's card.
  const rootOf = (id: string) => {
    for (let seen = 0, r = row(id); r?.parent_id && seen < 10; seen++, r = row(r.parent_id)) id = r.parent_id;
    return id;
  };
  // A one-shot is a draft or a summary, not an agent on the board.
  const running = all.filter((id) => !row(id)?.parent_id && !row(id)?.title?.startsWith(ONESHOT_TITLE));
  const active: OpencodeSnapshot["active"] = new Map(running.map((id) => [id, { dialog: null, activity: runningTool(db, id) }]));
  for (const id of all) {
    const live = active.get(rootOf(id));
    if (!live || live.dialog) continue;
    const pending = await opencodeApi<{ data: PermissionRequest[] }>("GET", `${sessionPath(id)}/permission`, undefined, { start: false }).catch(() => ({ data: [] }));
    if (pending.data[0]) live.dialog = permissionDialog(pending.data[0], new Date(now).toISOString());
  }
  const recent = new Set(
    ((db?.prepare("select id from session_v2 where parent_id is null and time_archived is null and time_idle > ? and (title is null or title not like ?)").all(now - IDLE_MS, `${ONESHOT_TITLE}%`) ?? []) as { id: string }[]).map((r) => r.id),
  );
  const sessions: OpencodeSnapshot["sessions"] = new Map();
  for (const id of new Set([...running, ...recent, ...previous.keys()])) {
    const r = row(id);
    if (r) sessions.set(id, { cwd: r.directory, idleAt: r.time_idle, archived: r.time_archived !== null });
  }
  const updates = opencodeStatusUpdates({ now, pid: reg.pid, active, recent, sessions, previous });
  for (const s of updates) writeStatus(statusDir, s);
  return updates.length;
}

/** Mark a session closed, as a pi process that exits does. OpenCode keeps it, so it can resume. */
export function closeOpencodeStatus(statusDir: string, sessionId: string): void {
  const old = readOpencodeStatuses(statusDir).get(sessionId);
  if (old) writeStatus(statusDir, { ...old, state: "closed", since: new Date().toISOString(), activity: null, dialog: null });
}

/** A session that the dash just started: show it as working before the next poll sees it. */
export function markOpencodeWorking(statusDir: string, sessionId: string, cwd: string): void {
  const reg = readRegistration();
  if (!reg) return;
  writeStatus(statusDir, { sessionId, pid: reg.pid, cwd, itermSessionId: null, agent: "opencode", inbox: true, version: 2, mode: "rpc", state: "working", since: new Date().toISOString(), activity: null, dialog: null });
}

let poller: NodeJS.Timeout | null = null;

/** Poll the service every 1.5 s. Idempotent: a second call does nothing. */
export function startOpencodeStatus(statusDir: string, dbFile: string, intervalMs = 1_500): void {
  if (poller) return;
  let busy = false;
  let warned = false;
  poller = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await pollOpencodeStatus(statusDir, dbFile);
      warned = false;
    } catch (err) {
      // One line per outage, not one per poll.
      if (!warned) console.warn(`agent-dash: cannot read OpenCode's status: ${(err as Error).message}`);
      warned = true;
    } finally {
      busy = false;
    }
  }, intervalMs);
  poller.unref();
}
