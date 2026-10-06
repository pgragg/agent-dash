import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// config.ts and the hook read these at import, so set them before those modules load.
const tmp = mkdtempSync(join(tmpdir(), "agent-dash-claude-"));
process.env.AGENT_DASH_STATUS_DIR = join(tmp, "status");
process.env.AGENT_DASH_CONVERSATIONS_DIR = join(tmp, "conversations");
process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
const { claudeHooksInstalled, headlessCommand, installClaudeHooks, summaryCommand, draftCommand, terminalCommand } = await import("../server/agent.ts");
const { deliver } = await import("../server/routes/liveControl.ts");
const { claudeResponse, newestOpenClaudeRequest, sameDialog } = await import("../server/rpc.ts");
const { parseSession, transcriptTurns } = await import("../server/sources/sessions.ts");
const { takesControls, takesSteer } = await import("../server/sources/status.ts");
// A computed path, as in liveControl.test.ts: the hook imports the pi extension, whose pi types tsc does not have.
const hookPath = "../extension/claude-status-hook.ts";
const hook = (await import(hookPath)) as { main: (event: string, input: Record<string, unknown>) => void };
const { buildConfig } = await import("../server/config.ts");
const { DEFAULT_SETTINGS, validateSettings } = await import("../shared/settings.ts");
const { NOW, PATTERN } = await import("./helpers.ts");

const at = (s: number) => new Date(NOW - 60_000 + s * 1000).toISOString();
const base = { sessionId: "c1", cwd: "/repo", isSidechain: false };
const userLine = (content: unknown, s: number, extra = {}) => ({ ...base, type: "user", timestamp: at(s), message: { role: "user", content }, ...extra });
const replyLine = (id: string, content: unknown[], stop: string, s: number, extra = {}) => ({ ...base, type: "assistant", timestamp: at(s), message: { id, role: "assistant", model: "claude-opus-5", content, stop_reason: stop }, ...extra });
const log = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

test("a Claude Code transcript reads like a pi log: name, prompts, one reply per message id, tool results and PRs", () => {
  const raw = log(
    { type: "custom-title", customTitle: "FSDK-5: fix the login", sessionId: "c1" },
    { type: "queue-operation", operation: "enqueue", sessionId: "c1" },
    userLine("Fix the login bug in FSDK-5", 0),
    userLine("<local-command-caveat>ignore</local-command-caveat>", 1, { isMeta: true }),
    replyLine("m1", [{ type: "thinking", thinking: "hmm" }], "tool_use", 2),
    replyLine("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr create --fill" } }], "tool_use", 3),
    userLine([{ type: "tool_result", tool_use_id: "t1", content: "https://github.com/o/r/pull/9" }], 4),
    replyLine("m2", [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "/repo/docs/flow.mmd", content: "graph TD\n  A-->B" } }], "tool_use", 5),
    userLine([{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "ok" }] }], 6),
    replyLine("m3", [{ type: "text", text: "Opened the PR." }], "end_turn", 7),
    replyLine("m3", [{ type: "text", text: "Should I merge it?" }], "end_turn", 8),
    userLine("subagent prompt FSDK-99", 9, { isSidechain: true }),
  );
  const s = parseSession(raw, "/c1.jsonl", new Date(NOW), PATTERN)!;
  assert.equal(s.agent, "claude");
  assert.deepEqual([s.sessionId, s.cwd, s.name, s.startedAt], ["c1", "/repo", "FSDK-5: fix the login", at(0)]);
  assert.equal(s.firstPrompt, "Fix the login bug in FSDK-5");
  // The meta line, the tool results and the subagent's prompt are not your prompts.
  assert.equal(s.userMessageCount, 1);
  assert.deepEqual(s.tickets, ["FSDK-5"]);
  assert.deepEqual(s.createdPrs, ["https://github.com/o/r/pull/9"]);
  assert.equal(s.model, "claude-opus-5");
  assert.equal(s.lastMessage, "Opened the PR.\nShould I merge it?");
  assert.equal(s.askedQuestion, true);
  assert.deepEqual([s.lastStopReason, s.midRun], ["stop", false]);
  assert.deepEqual(s.diagrams?.map((d) => [d.kind, d.origin]), [["mermaid", "/repo/docs/flow.mmd"]]);
  assert.deepEqual(
    transcriptTurns(raw).map((t) => [t.role, t.text]),
    [
      ["user", "Fix the login bug in FSDK-5"],
      ["assistant", "Opened the PR.\nShould I merge it?"],
    ],
  );
});

test("Esc in Claude Code is a stop by you, and a pending tool call is mid-run", () => {
  const stopped = log(userLine("go", 0), replyLine("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 30" } }], "tool_use", 1), userLine([{ type: "text", text: "[Request interrupted by user for tool use]" }], 2));
  const s = parseSession(stopped, "/f", new Date(NOW), PATTERN)!;
  assert.deepEqual([s.lastStopReason, s.midRun, s.userMessageCount], ["aborted", false, 1]);
  const running = parseSession(log(userLine("go", 0), replyLine("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 30" } }], "tool_use", 1)), "/f", new Date(NOW), PATTERN)!;
  assert.equal(running.midRun, true);
});

test("a headless Claude Code reads stream-json on stdin and asks on stdin before a tool call", () => {
  const fresh = headlessCommand("claude", "id-1", { name: "FSDK-5: hi" });
  assert.equal(fresh.cmd, "claude");
  assert.deepEqual(fresh.args.slice(0, 9), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--settings"]);
  assert.deepEqual(fresh.args.slice(-4), ["--session-id", "id-1", "--name", "FSDK-5: hi"]);
  const hooks = JSON.parse(fresh.args[9]).hooks;
  assert.deepEqual(Object.keys(hooks), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd"]);
  assert.match(hooks.Stop[0].hooks[0].command, /claude-status-hook\.ts' Stop$/);
  // A resume finds the session by id in its folder, and keeps its name.
  assert.deepEqual(headlessCommand("claude", "id-1", { name: "x", resume: { sessionId: "id-1", sessionFile: "/s/a.jsonl" } }).args.slice(-2), ["--resume", "id-1"]);
  assert.match(terminalCommand("claude", "/repo", "FSDK-5: hi", "/h/c.md", "/h/m.txt", "id-1"), /^cd '\/repo' && claude --session-id 'id-1' --name 'FSDK-5: hi' '--settings' '\{"hooks".*"\$\(cat '\/h\/c\.md'; printf '\\n\\n'; cat '\/h\/m\.txt'\)"$/);
  // The dash's own one-turn runs stay off the board.
  for (const c of [draftCommand("claude", "p"), summaryCommand("claude", "p", { name: "n", sessionDir: "/x" })]) {
    assert.ok(c.args.includes("--no-session-persistence"));
    assert.equal(c.env.AGENT_DASH_NO_STATUS, "1");
    // `--tools` takes many values; without `--` it would read the prompt as a tool name.
    assert.deepEqual(c.args.slice(-2), ["--", "p"]);
  }
});

test("the install adds the hooks next to the user's own, once, and then the dash passes none of its own", () => {
  mkdirSync(join(tmp, "claude"), { recursive: true });
  const file = join(tmp, "claude", "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
  assert.equal(claudeHooksInstalled(), false);
  assert.match(installClaudeHooks(), /^Installed/);
  assert.match(installClaudeHooks(), /^Already installed/);
  const s = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(s.theme, "dark");
  assert.deepEqual(s.hooks.Stop.map((e: { hooks: { command: string }[] }) => e.hooks[0].command.endsWith(" Stop") || e.hooks[0].command), ["say done", true]);
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.ok(!headlessCommand("claude", "id-1", {}).args.includes("--settings"));
  writeFileSync(file, "{}");
});

test("the hook writes the status file that the pi extension writes, with dialogs and no steer", () => {
  const status = () => JSON.parse(readFileSync(join(tmp, "status", "hook-run-1.json"), "utf8"));
  const input = { session_id: "hook-run-1", transcript_path: "/t/hook-run-1.jsonl", cwd: "/repo" };
  process.env.AGENT_DASH_MODE = "rpc";
  try {
    hook.main("SessionStart", input);
    assert.deepEqual([status().state, status().agent, status().inbox, status().mode, status().sessionFile], ["awaiting_input", "claude", true, "rpc", "/t/hook-run-1.jsonl"]);
    hook.main("UserPromptSubmit", input);
    hook.main("PreToolUse", { ...input, tool_name: "Bash", tool_input: { command: "GITHUB_TOKEN=ghp_1 gh pr list" } });
    assert.equal(status().state, "working");
    assert.deepEqual([status().activity.tool, status().activity.summary], ["Bash", "GITHUB_TOKEN=*** gh pr list"]);
    hook.main("PermissionRequest", { ...input, tool_name: "Write", tool_input: { file_path: "/repo/a.ts", content: "x" } });
    assert.deepEqual([status().dialog.method, status().dialog.title], ["confirm", "Allow Write: /repo/a.ts?"]);
    assert.deepEqual([takesControls(status()), takesSteer(status())], [true, false]);
    hook.main("Stop", input);
    assert.deepEqual([status().state, status().activity, status().dialog], ["awaiting_input", null, null]);
  } finally {
    delete process.env.AGENT_DASH_MODE;
  }
  hook.main("SessionEnd", input);
  // A terminal session takes no replies from the page.
  assert.deepEqual([status().state, status().inbox, status().mode], ["closed", false, "tui"]);
  process.env.AGENT_DASH_NO_STATUS = "1";
  hook.main("SessionStart", { ...input, session_id: "h2-summary" });
  delete process.env.AGENT_DASH_NO_STATUS;
  assert.throws(() => readFileSync(join(tmp, "status", "h2-summary.json")));
});

test("a permission request is answered once: yes runs the tool as asked, no and Stop deny it", () => {
  const request = { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/repo/a.ts", content: "x" } } };
  const text = `{"type":"system"}\n${JSON.stringify(request)}\n`;
  const req = newestOpenClaudeRequest(text, new Set())!;
  assert.ok(sameDialog(req, { method: "confirm", title: "Allow Write: /repo/a.ts?", since: new Date(NOW).toISOString() }));
  assert.equal(newestOpenClaudeRequest(text, new Set(["r1"])), null);
  const yes = JSON.parse((claudeResponse(req, { confirmed: true }) as { line: string }).line);
  assert.deepEqual(yes, { type: "control_response", response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { file_path: "/repo/a.ts", content: "x" } } } });
  for (const answer of [{ confirmed: false }, { cancelled: true as const }]) assert.equal(JSON.parse((claudeResponse(req, answer) as { line: string }).line).response.response.behavior, "deny");
  assert.ok("error" in claudeResponse(req, { value: "x" }));
});

test("a reply to a headless Claude Code goes to its stdin; Stop interrupts it and marks it waiting", () => {
  mkdirSync(join(tmp, "conversations"), { recursive: true });
  mkdirSync(join(tmp, "status"), { recursive: true });
  const fifo = join(tmp, "conversations", "live-claude-1.in");
  execFileSync("mkfifo", [fifo]);
  const fd = openSync(fifo, "r+");
  const read = () => {
    const buf = Buffer.alloc(4096);
    return buf.subarray(0, readSync(fd, buf)).toString();
  };
  writeFileSync(join(tmp, "status", "live-claude-1.json"), JSON.stringify({ sessionId: "live-claude-1", pid: process.pid, agent: "claude", inbox: true, version: 2, mode: "rpc", state: "working", since: NOW, activity: { tool: "Bash", summary: "x", since: new Date(NOW).toISOString() } }));
  try {
    deliver("live-claude-1", "txt", "then summarize");
    assert.deepEqual(JSON.parse(read()), { type: "user", message: { role: "user", content: "then summarize" } });
    deliver("live-claude-1", "abort", "");
    assert.equal(JSON.parse(read()).request.subtype, "interrupt");
    const after = JSON.parse(readFileSync(join(tmp, "status", "live-claude-1.json"), "utf8"));
    assert.deepEqual([after.state, after.activity], ["awaiting_input", null]);
  } finally {
    closeSync(fd);
  }
});

test("the agent is a choice, and it picks the session folder that the board reads", () => {
  assert.equal(validateSettings({ agent: "claude" }).settings.agent, "claude");
  assert.match(validateSettings({ agent: "codex" }).errors.agent ?? "", /must be one of pi, claude/);
  assert.match(buildConfig({ ...DEFAULT_SETTINGS, agent: "claude" }).sessionsDir, /\.claude\/projects$/);
  assert.match(buildConfig(DEFAULT_SETTINGS).sessionsDir, /\.pi\/agent\/sessions$/);
});
