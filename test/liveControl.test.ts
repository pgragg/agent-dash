import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDashboard } from "../server/model.ts";
import { newestOpenDialog, readLogTail, sameDialog, uiResponse, type UiRequest, writeFifoLine } from "../server/rpc.ts";
import { type ParsedSession, parseSession } from "../server/sources/sessions.ts";
import { type ReportedStatus, resolveReported, takesControls } from "../server/sources/status.ts";
import { activityParts } from "../shared/activity.ts";
import { header, jsonl, minutesAgo, NOW, PATTERN, ticket, toolCall, user } from "./helpers.ts";

const tmp = mkdtempSync(join(tmpdir(), "agent-dash-live-"));
process.env.AGENT_DASH_STATUS_DIR = join(tmp, "status");
process.env.AGENT_DASH_INBOX_DIR = join(tmp, "inbox");
// A computed path: the extension imports pi's types, which this repo does not install for tsc.
const extensionPath = "../extension/agent-dash-status.ts";
const ext = (await import(extensionPath)) as { default: (pi: unknown) => void; summarizeTool: (tool: string, args: unknown) => string };

const until = async (ok: () => boolean, ms = 3_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return;
  assert.fail("timed out");
};

test("the tool summary is one short line, without file contents or secrets", () => {
  assert.equal(ext.summarizeTool("bash", { command: "pnpm   test\n  --watch" }), "pnpm test --watch");
  assert.equal(ext.summarizeTool("bash", { command: "x".repeat(200) }).length, 80);
  assert.equal(ext.summarizeTool("write", { path: "src/a.ts", content: "secret body" }), "src/a.ts");
  assert.equal(ext.summarizeTool("bash", { command: 'curl -H "Authorization: Bearer abc.def" https://x?token=s3cr3t&a=1' }), 'curl -H "Authorization: *** ***" https://x?token=***&a=1');
  assert.equal(ext.summarizeTool("bash", { command: "GITHUB_TOKEN=ghp_123 gh api --password hunter2" }), "GITHUB_TOKEN=*** gh api --password ***");
  assert.equal(ext.summarizeTool("bash", { command: "AWS_ACCESS_KEY_ID=AKIA1 GH_PAT=x git push https://me:pw@gh.io --path=a" }), "AWS_ACCESS_KEY_ID=*** GH_PAT=*** git push https://***:***@gh.io --path=a");
  assert.equal(ext.summarizeTool("edit", { file_path: "a/b.ts" }), "a/b.ts");
  assert.equal(ext.summarizeTool("my_tool", { anything: 1 }), "");
});

test("the extension reports the running tool, takes Stop and Steer, and reports dialogs", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const sent: [string, unknown][] = [];
  let idle = true;
  let aborted = 0;
  let answer: (v: boolean) => void = () => {};
  // Like pi's own dialogs: an abort of opts.signal closes the dialog with the default answer.
  const ui = {
    confirm: (_t: string, _m: string, opts?: { signal?: AbortSignal }) =>
      new Promise<boolean>((r) => {
        answer = r;
        opts?.signal?.addEventListener("abort", () => r(false));
      }),
  };
  const ctx = {
    sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => "/f.jsonl" },
    cwd: "/repo",
    mode: "rpc",
    hasUI: true,
    ui,
    isIdle: () => idle,
    abort: () => aborted++,
  };
  ext.default({ on: (name: string, fn: (e: unknown, c: unknown) => Promise<void>) => handlers.set(name, fn), sendUserMessage: (text: string, opts?: unknown) => sent.push([text, opts]) });
  const fire = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
  const status = () => JSON.parse(readFileSync(join(tmp, "status", "sess-1.json"), "utf8"));
  const inbox = join(tmp, "inbox", "sess-1");

  await fire("session_start");
  assert.equal(status().version, 2);
  assert.equal(status().activity, null);
  await fire("agent_start");
  idle = false;
  await fire("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "sleep 20" } });
  // Throttled: the file shows the tool within the write interval, not at once.
  await until(() => status().activity?.summary === "sleep 20");
  assert.equal(status().activity.tool, "bash");
  assert.equal(status().state, "working");

  // Real names are <ms>-<pid>.<suffix>, so they arrive in the order they were sent.
  writeFileSync(join(inbox, "1790000000001-9.steer"), "look at the tests first");
  writeFileSync(join(inbox, "1790000000002-9.txt"), "then summarize");
  writeFileSync(join(inbox, "1790000000003-9.abort"), "");
  await until(() => aborted === 1 && sent.length === 2);
  assert.deepEqual(sent, [
    ["look at the tests first", { deliverAs: "steer" }],
    ["then summarize", { deliverAs: "followUp" }],
  ]);

  await fire("tool_execution_end", { toolCallId: "t1" });
  await fire("agent_settled");
  idle = true;
  assert.equal(status().activity, null);
  assert.equal(status().state, "awaiting_input");

  const pending = (ctx.ui as typeof ui).confirm("Allow rm?", "It deletes build/");
  assert.deepEqual({ ...status().dialog, since: undefined }, { method: "confirm", title: "Allow rm?", message: "It deletes build/", since: undefined });
  answer(true);
  assert.equal(await pending, true);
  assert.equal(status().dialog, null);

  // Stop also dismisses an open dialog, so a run blocked on one can still be stopped.
  const blocked = (ctx.ui as typeof ui).confirm("Allow push?", "");
  writeFileSync(join(inbox, "1790000000004-9.abort"), "");
  assert.equal(await blocked, false);
  assert.equal(status().dialog, null);
  await fire("session_shutdown");
});

const reported = (over: Partial<ReportedStatus> = {}): ReportedStatus => ({ sessionId: "s", pid: 1, state: "working", since: minutesAgo(5), inbox: true, ...over });

test("an open dialog means the run waits for you; Stop and Steer need extension version 2", () => {
  assert.deepEqual(resolveReported(reported({ dialog: { method: "confirm", title: "t", since: minutesAgo(1) } }), () => true), { status: "awaiting_input", since: minutesAgo(1) });
  assert.equal(takesControls(reported()), false);
  assert.equal(takesControls(reported({ version: 2 })), true);
  assert.equal(takesControls(reported({ version: 2, inbox: false })), false);
});

test("a run shows its activity only while working, and an old status file has none", () => {
  const session = (sessionId: string): ParsedSession => ({
    agent: "pi", sessionId, sessionFile: "/f", cwd: "/repo", name: null, firstPrompt: "p", lastReply: "", lastMessage: "", askedQuestion: false, startedAt: minutesAgo(10),
    lastActivityAt: minutesAgo(1), model: null, lastStopReason: "stop", midRun: false, tickets: [], createdPrs: [], mentionedPrs: [], userMessageCount: 1,
  });
  const activity = { tool: "bash", summary: "pnpm test", since: minutesAgo(1) };
  const d = buildDashboard({
    sessions: [session("new"), session("old"), session("idle")],
    reported: new Map([
      ["new", reported({ sessionId: "new", version: 2, activity })],
      ["old", reported({ sessionId: "old" })],
      ["idle", reported({ sessionId: "idle", version: 2, state: "awaiting_input", activity })],
    ]),
    myTickets: [ticket()], otherTickets: [], prs: [], now: NOW, recentDays: 14,
    sources: { jira: { ok: true }, github: { ok: true }, sessions: { ok: true } }, extensionInstalled: true, jiraServer: "https://jira",
    isAlive: () => true,
  });
  const byId = new Map(d.unlinkedRuns.map((r) => [r.sessionId, r]));
  assert.deepEqual(byId.get("new")?.activity, activity);
  assert.equal(byId.get("new")?.canControl, true);
  assert.equal(byId.get("old")?.activity, null);
  assert.equal(byId.get("old")?.canControl, false);
  assert.equal(byId.get("idle")?.activity, null);
});

test("the activity line reads like 'running `pnpm test` · 40s'", () => {
  assert.deepEqual(activityParts({ tool: "bash", summary: "pnpm test", since: new Date(NOW - 40_000).toISOString() }, NOW), { verb: "running", code: "pnpm test", elapsed: "40s" });
  assert.equal(activityParts({ tool: "read", summary: "a.ts", since: new Date(NOW - 125_000).toISOString() }, NOW).elapsed, "2m 5s");
  assert.equal(activityParts({ tool: "web_search", summary: "", since: new Date(NOW).toISOString() }, NOW).verb, "using web_search");
  assert.equal(activityParts({ tool: "bash", summary: "x", since: "not a date" }, NOW).elapsed, "");
});

const req = (id: string, method = "confirm", extra: object = {}) => JSON.stringify({ type: "extension_ui_request", id, method, title: "T", ...extra });

test("the newest unanswered dialog request wins; notify lines and answered ids do not count", () => {
  const log = [req("a"), '{"type":"message_update"}', req("b", "select", { options: ["x", "y"] }), req("n", "notify"), '{"type":"extension_ui_req'].join("\n");
  assert.equal(newestOpenDialog(log, new Set())?.id, "b");
  assert.equal(newestOpenDialog(log, new Set(["b"]))?.id, "a");
  assert.equal(newestOpenDialog(log, new Set(["a", "b"])), null);
  // A JSON string may hold U+2028; only LF ends a record.
  assert.equal(newestOpenDialog(req("c", "input", { title: "line\u2028sep" }), new Set())?.title, "line\u2028sep");
});

test("the response line fits the dialog, and a select answer must be one of its options", () => {
  const select = JSON.parse(req("s", "select", { options: ["Allow", "Block"] })) as UiRequest;
  assert.deepEqual(uiResponse(select, { value: "Allow" }), { line: '{"type":"extension_ui_response","id":"s","value":"Allow"}' });
  assert.ok("error" in uiResponse(select, { value: "rm -rf" }));
  // The page answers by index, because it shows options cut to one line.
  const long = JSON.parse(req("l", "select", { options: ["Allow\n(dangerous)", "Block"] })) as UiRequest;
  assert.deepEqual(uiResponse(long, { index: 0 }), { line: JSON.stringify({ type: "extension_ui_response", id: "l", value: "Allow\n(dangerous)" }) });
  assert.ok("error" in uiResponse(long, { index: 2 }));
  const confirm = JSON.parse(req("c")) as UiRequest;
  assert.deepEqual(uiResponse(confirm, { confirmed: false }), { line: '{"type":"extension_ui_response","id":"c","confirmed":false}' });
  assert.ok("error" in uiResponse(confirm, { value: "yes" }));
  assert.deepEqual(uiResponse(confirm, { cancelled: true }), { line: '{"type":"extension_ui_response","id":"c","cancelled":true}' });
  assert.equal(sameDialog({ ...confirm, title: "A  long\ntitle that goes on" }, { method: "confirm", title: "A long title that…", since: "" }), true);
  assert.equal(sameDialog(confirm, { method: "select", title: "T", since: "" }), false);
});

test("the log tail drops its cut first line", async () => {
  const file = join(tmp, "tail.log");
  writeFileSync(file, `${req("old")}\n${req("new")}\n`);
  assert.equal(newestOpenDialog(await readLogTail(file, req("new").length + 5), new Set())?.id, "new");
  assert.ok(!(await readLogTail(file, req("new").length + 5)).includes('"old"'));
});

test("a FIFO line goes to the reader, and with no reader the write fails instead of hanging", () => {
  mkdirSync(join(tmp, "fifo"), { recursive: true });
  const fifo = join(tmp, "fifo", "x.in");
  execFileSync("mkfifo", [fifo]);
  assert.throws(() => writeFifoLine(fifo, "{}"), { code: "ENXIO" });
  // pi opens its stdin FIFO read-write, as conversations.ts does.
  const fd = openSync(fifo, "r+");
  writeFifoLine(fifo, '{"a":1}');
  const buf = Buffer.alloc(64);
  const n = readSync(fd, buf);
  closeSync(fd);
  assert.equal(buf.subarray(0, n).toString(), '{"a":1}\n');
});

test("Stop during a tool call is a stop by you, not an API error", () => {
  const aborted = { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", content: [] } };
  const s = parseSession(jsonl(header(), user("go"), toolCall("t1", "sleep 20"), aborted), "/f.jsonl", new Date(NOW), PATTERN)!;
  assert.equal(s.lastStopReason, "aborted");
});
