import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { ReportedStatus } from "../server/sources/status.ts";

// config.ts and opencode.ts read these, so set them before those modules load.
const tmp = mkdtempSync(join(tmpdir(), "agent-dash-opencode-"));
process.env.AGENT_DASH_STATUS_DIR = join(tmp, "status");
process.env.XDG_STATE_HOME = join(tmp, "state");
const { draftCommand, summaryCommand, terminalCommand } = await import("../server/agent.ts");
const { newSessionId } = await import("../server/conversations.ts");
const { deliver } = await import("../server/routes/liveControl.ts");
const { resumeBlocker } = await import("../server/routes/resume.ts");
const { ONESHOT_TITLE, opencodeAsPiLog, opencodeStatusUpdates, pollOpencodeStatus, syncOpencodeLogs } = await import("../server/opencode.ts");
const { oneshotArgs } = await import("../server/opencode-oneshot.ts");
const { parseSession, transcriptTurns } = await import("../server/sources/sessions.ts");
const { takesSteer } = await import("../server/sources/status.ts");
const { buildConfig } = await import("../server/config.ts");
const { DEFAULT_SETTINGS, validateSettings } = await import("../shared/settings.ts");
const { NOW, PATTERN } = await import("./helpers.ts");

const session = { id: "ses_1", directory: "/repo", title: "FSDK-5: fix the login", time_created: NOW - 60_000 };
const msg = (type: string, data: object) => ({ type, data: JSON.stringify(data) });
const tool = (id: string, name: string, input: object, state: object) => ({ type: "tool", id, name, state: { input, ...state }, time: { created: NOW - 40_000, completed: NOW - 39_000 } });
const messages = [
  msg("user", { time: { created: NOW - 50_000 }, text: "Fix the login bug in FSDK-5" }),
  msg("assistant", {
    time: { created: NOW - 45_000, completed: NOW - 39_000 },
    model: { id: "claude-opus-5", providerID: "anthropic" },
    content: [{ type: "reasoning", text: "hmm" }, tool("t1", "shell", { command: "gh pr create --fill" }, { status: "completed", content: [{ type: "text", text: "https://github.com/o/r/pull/9" }] })],
    finish: "tool-calls",
  }),
  msg("assistant", { time: { created: NOW - 30_000, completed: NOW - 29_000 }, model: { id: "claude-opus-5" }, content: [{ type: "text", text: "Opened the PR. Should I merge it?" }], finish: "stop" }),
  msg("idle", { time: { created: NOW - 29_000 }, outcome: "succeeded" }),
];

test("an OpenCode session reads like a pi log: its title, prompts, replies, tool results and PRs", () => {
  const raw = opencodeAsPiLog(session, messages);
  const s = parseSession(raw, "/f.jsonl", new Date(NOW), PATTERN)!;
  assert.equal(s.agent, "opencode");
  assert.equal(s.sessionId, "ses_1");
  assert.equal(s.cwd, "/repo");
  assert.equal(s.name, "FSDK-5: fix the login");
  assert.deepEqual(s.tickets, ["FSDK-5"]);
  // `shell` reads as pi's bash, so the PR that it opened counts as made here.
  assert.deepEqual(s.createdPrs, ["https://github.com/o/r/pull/9"]);
  assert.equal(s.model, "claude-opus-5");
  assert.equal(s.lastStopReason, "stop");
  assert.equal(s.midRun, false);
  assert.equal(s.askedQuestion, true);
  assert.deepEqual(
    transcriptTurns(raw).map((t) => t.role),
    ["user", "assistant"],
  );
});

test("an interrupted turn reads as a stop, and a reply that still runs as mid-run", () => {
  const stopped = parseSession(opencodeAsPiLog(session, [...messages.slice(0, 2), msg("idle", { time: { created: NOW }, outcome: "interrupted" })]), "/f", new Date(NOW), PATTERN)!;
  assert.equal(stopped.lastStopReason, "aborted");
  const running = parseSession(opencodeAsPiLog(session, [messages[0], msg("assistant", { time: { created: NOW }, content: [tool("t2", "shell", { command: "sleep 9" }, { status: "running", metadata: {} })] })]), "/f", new Date(NOW), PATTERN)!;
  assert.equal(running.midRun, true);
});

function makeDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`create table session_v2 (id text primary key, directory text, title text, parent_id text, time_created integer, time_updated integer, time_idle integer, time_archived integer);
    create table session_message (id text primary key, session_id text, type text, seq integer, time_updated integer, data text);`);
  return db;
}

const addSession = (db: DatabaseSync, s: { id: string; directory?: string; title?: string | null; parent?: string; idle?: number | null; archived?: number }) =>
  db.prepare("insert into session_v2 values (?, ?, ?, ?, ?, ?, ?, ?)").run(s.id, s.directory ?? "/repo", s.title ?? null, s.parent ?? null, NOW - 60_000, NOW - 60_000, s.idle ?? null, s.archived ?? null);
const addMessages = (db: DatabaseSync, sessionId: string, rows: { type: string; data: string }[], updated = NOW - 20_000) =>
  rows.forEach((r, i) => db.prepare("insert into session_message values (?, ?, ?, ?, ?, ?)").run(`${sessionId}-m${i}`, sessionId, r.type, i, updated, r.data));

test("the database becomes one pi log per top-level session, with the newest message time as mtime", () => {
  const dir = mkdtempSync(join(tmp, "sync-"));
  const db = makeDb(join(dir, "opencode.db"));
  addSession(db, { id: "ses_a", title: "FSDK-5: fix" });
  addMessages(db, "ses_a", messages);
  addSession(db, { id: "ses_child", parent: "ses_a" });
  addSession(db, { id: "ses_draft", title: `${ONESHOT_TITLE}: summary` });
  const out = join(dir, "logs");
  syncOpencodeLogs(join(dir, "opencode.db"), out);
  const file = join(out, "repo", "ses_a.jsonl");
  assert.deepEqual(readdirSync(join(out, "repo")), ["ses_a.jsonl"]);
  assert.equal(statSync(file).mtimeMs, NOW - 20_000);
  assert.equal(parseSession(readFileSync(file, "utf8"), file, statSync(file).mtime, PATTERN)?.agent, "opencode");

  // A deleted session leaves the board.
  db.exec("delete from session_message; delete from session_v2");
  syncOpencodeLogs(join(dir, "opencode.db"), out);
  assert.deepEqual(readdirSync(join(out, "repo")), []);
});

const snapshot = (over: Partial<Parameters<typeof opencodeStatusUpdates>[0]> = {}) => ({
  now: NOW,
  pid: 42,
  active: new Map(),
  recent: new Set<string>(),
  sessions: new Map([["ses_1", { cwd: "/repo", idleAt: NOW - 60_000, archived: false }]]),
  previous: new Map<string, ReportedStatus>(),
  ...over,
});
const status = (over: Partial<ReportedStatus>): ReportedStatus => ({ sessionId: "ses_1", pid: 42, cwd: "/repo", itermSessionId: null, agent: "opencode", inbox: true, version: 2, mode: "rpc", state: "working", since: new Date(NOW - 5_000).toISOString(), activity: null, dialog: null, ...over });

test("a running session works, shows its permission request, then waits on you, and closes after four idle hours", () => {
  const dialog = { id: "per_1", sessionID: "ses_1", method: "confirm" as const, title: "Allow shell: rm -rf x?", message: "rm -rf x", since: new Date(NOW).toISOString() };
  const [working] = opencodeStatusUpdates(snapshot({ active: new Map([["ses_1", { dialog, activity: null }]]) }));
  assert.equal(working.state, "working");
  assert.equal(working.dialog?.title, "Allow shell: rm -rf x?");
  assert.equal(working.mode, "rpc");
  assert.ok(takesSteer(working));

  const [waiting] = opencodeStatusUpdates(snapshot({ previous: new Map([["ses_1", working]]) }));
  assert.deepEqual([waiting.state, waiting.since, waiting.dialog], ["awaiting_input", new Date(NOW - 60_000).toISOString(), null]);
  // Nothing changed: nothing to write.
  assert.deepEqual(opencodeStatusUpdates(snapshot({ previous: new Map([["ses_1", waiting]]) })), []);

  const [closed] = opencodeStatusUpdates(snapshot({ now: NOW + 5 * 3600_000, previous: new Map([["ses_1", waiting]]) }));
  assert.equal(closed.state, "closed");
  assert.deepEqual(opencodeStatusUpdates(snapshot({ previous: new Map([["ses_1", closed]]), recent: new Set(["ses_1"]) })), []);
  // It opens again when it runs.
  assert.equal(opencodeStatusUpdates(snapshot({ previous: new Map([["ses_1", closed]]), active: new Map([["ses_1", { dialog: null, activity: null }]]) }))[0].state, "working");
});

test("a session that just ran waits on you, also from before the dash started; a deleted one closes", () => {
  assert.equal(opencodeStatusUpdates(snapshot({ recent: new Set(["ses_1"]) }))[0].state, "awaiting_input");
  assert.equal(opencodeStatusUpdates(snapshot({ sessions: new Map(), previous: new Map([["ses_1", status({ state: "awaiting_input" })]]) }))[0].state, "closed");
  // A new service pid is written, so the old one does not read as finished.
  assert.equal(opencodeStatusUpdates(snapshot({ pid: 43, previous: new Map([["ses_1", status({ state: "awaiting_input", since: new Date(NOW - 60_000).toISOString() })]]) }))[0].pid, 43);
});

test("drafts and summaries are one-shot OpenCode sessions; a terminal run makes its named session first", () => {
  const draft = draftCommand("opencode", "write it");
  assert.equal(draft.cmd, process.execPath);
  const d = oneshotArgs(draft.args.slice(1));
  assert.deepEqual([d.mode, d.model, d.title, readFileSync(d.promptFile, "utf8")], ["draft", "anthropic/claude-haiku-4-5", "draft", "write it"]);
  rmSync(d.promptFile);
  // The prompt stays off argv.
  assert.ok(!draft.args.includes("write it"));
  const summary = summaryCommand("opencode", "sum up", { name: "agent-dash summary FSDK-5", sessionDir: "/x" });
  const sum = oneshotArgs(summary.args.slice(1));
  assert.deepEqual([sum.mode, sum.model, sum.title, readFileSync(sum.promptFile, "utf8")], ["summary", undefined, "agent-dash summary FSDK-5", "sum up"]);
  rmSync(sum.promptFile);
  assert.equal(
    terminalCommand("opencode", "/repo", "FSDK-5: hi", "/h/c.md", "/h/m.txt", "ses_1"),
    `cd '/repo' && opencode api session.create -d '{"id":"ses_1","title":"FSDK-5: hi","location":{"directory":"/repo"}}' >/dev/null; opencode --session 'ses_1' --prompt "$(cat '/h/c.md'; printf '\\n\\n'; cat '/h/m.txt')"`,
  );
  assert.match(newSessionId("opencode"), /^ses_[0-9a-f]{32}$/);
});

test("an OpenCode session resumes without a status file: its service takes a message at any time", () => {
  const s = parseSession(opencodeAsPiLog({ ...session, directory: tmp }, messages), "/f", new Date(NOW), PATTERN)!;
  assert.equal(resumeBlocker(s, undefined, { running: false }), null);
  assert.equal(resumeBlocker(s, undefined, { running: true }), "this session is still running");
});

test("OpenCode is a choice of agent, and its board reads the dash's copies of its sessions", () => {
  assert.equal(validateSettings({ agent: "opencode" }).settings.agent, "opencode");
  assert.match(buildConfig({ ...DEFAULT_SETTINGS, agent: "opencode" }).sessionsDir, /\.agent-dash\/opencode-sessions$/);
});

// A fake OpenCode service: the registration file points at it, with this process's pid.
const calls: { method: string; url: string; auth?: string; body: unknown }[] = [];
const service = createServer(async (req: IncomingMessage, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
  const reply = (data: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
  if (req.url === "/api/session/active") return reply({ data: { ses_runner: { type: "running" }, ses_subagent: { type: "running" } } });
  if (req.url === "/api/session/ses_subagent/permission") return reply({ data: [{ id: "per_9", sessionID: "ses_subagent", action: "shell", resources: ["rm -rf build"] }] });
  if (req.url?.endsWith("/permission")) return reply({ data: [] });
  if (req.url === "/api/session/ses_runner/interrupt") return reply({ interrupted: true });
  res.writeHead(204).end();
});
await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
after(() => service.close());
mkdirSync(join(tmp, "state", "opencode"), { recursive: true });
writeFileSync(join(tmp, "state", "opencode", "service.json"), JSON.stringify({ url: `http://127.0.0.1:${(service.address() as AddressInfo).port}`, pid: process.pid, password: "pw" }));

test("replies, steers and Stop go to OpenCode's API, with the service's password", async () => {
  calls.length = 0;
  const live = status({ sessionId: "ses_runner" });
  await deliver("ses_runner", "txt", "then summarize", live);
  await deliver("ses_runner", "steer", "look at the tests", live);
  await deliver("ses_runner", "abort", "", live);
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.body]),
    [
      ["POST", "/api/session/ses_runner/prompt", { text: "then summarize", delivery: "queue" }],
      ["POST", "/api/session/ses_runner/prompt", { text: "look at the tests", delivery: "steer" }],
      ["POST", "/api/session/ses_runner/interrupt", undefined],
    ],
  );
  assert.equal(calls[0].auth, `Basic ${Buffer.from("opencode:pw").toString("base64")}`);
});

test("a poll writes a status file per running session; a subagent's permission request shows on its parent", async () => {
  const dir = mkdtempSync(join(tmp, "poll-"));
  const db = makeDb(join(dir, "opencode.db"));
  addSession(db, { id: "ses_runner", directory: "/work", title: "FSDK-5: run" });
  addSession(db, { id: "ses_subagent", parent: "ses_runner" });
  addMessages(db, "ses_runner", [msg("assistant", { time: { created: NOW }, content: [tool("t1", "shell", { command: "pnpm test" }, { status: "running", metadata: {} })] })]);
  const statusDir = join(dir, "status");
  assert.equal(await pollOpencodeStatus(statusDir, join(dir, "opencode.db"), NOW), 1);
  assert.deepEqual(readdirSync(statusDir), ["ses_runner.json"]);
  const s = JSON.parse(readFileSync(join(statusDir, "ses_runner.json"), "utf8")) as ReportedStatus & { dialog: { id: string; sessionID: string } };
  assert.deepEqual([s.state, s.cwd, s.pid, s.agent], ["working", "/work", process.pid, "opencode"]);
  assert.deepEqual([s.dialog.title, s.dialog.id, s.dialog.sessionID], ["Allow shell: rm -rf build?", "per_9", "ses_subagent"]);
  assert.deepEqual([s.activity?.tool, s.activity?.summary], ["bash", "pnpm test"]);
});
