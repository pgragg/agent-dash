import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { rpcArgs } from "../server/conversations.ts";
import { agentMessage, agentName, HANDOFF_END, HANDOFF_START } from "../server/handoff.ts";
import { resumeBlocker } from "../server/routes/resume.ts";
import { parseSession, transcriptTurns } from "../server/sources/sessions.ts";
import type { ReportedStatus } from "../server/sources/status.ts";
import { header, jsonl, minutesAgo, name, NOW, PATTERN, reply, user } from "./helpers.ts";

test("a new headless run gets the server's id and its name; a resumed one opens its file", () => {
  assert.deepEqual(rpcArgs("id-1", { name: "FSDK-5: say hi" }), ["--mode", "rpc", "--session-id", "id-1", "--name", "FSDK-5: say hi"]);
  assert.deepEqual(rpcArgs("id-1", {}), ["--mode", "rpc", "--session-id", "id-1"]);
  assert.deepEqual(rpcArgs("id-1", { resume: { sessionId: "id-1", sessionFile: "/s/a.jsonl" } }), ["--mode", "rpc", "--session", "/s/a.jsonl"]);
});

test("the name carries the key and the first line of the task, without markdown", () => {
  assert.equal(agentName("FSDK-5", "**Piper:** ping `Arie`\nsecond line"), "FSDK-5: Piper: ping Arie");
  assert.equal(agentName("FSDK-5", "x".repeat(100)).length, "FSDK-5: ".length + 60);
});

test("a headless ticket agent links to its ticket only, with the context inline in the first message", () => {
  const ctx = `${HANDOFF_START("FSDK-5")}\nNotes mention FSDK-77 and FSDK-88, and https://github.com/o/r/pull/3\n${HANDOFF_END}`;
  const first = agentMessage(ctx, "  say hi ");
  assert.ok(first.endsWith("\n\nsay hi"));
  const raw = jsonl(header(), name(agentName("FSDK-5", "say hi")), user(first), reply("hi"));
  const s = parseSession(raw, "/f.jsonl", new Date(NOW), PATTERN)!;
  assert.deepEqual(s.tickets, ["FSDK-5"]);
  assert.deepEqual(s.mentionedPrs, []);
  assert.equal(s.firstPrompt, "[agent-dash context for FSDK-5] say hi");
  // Without the name, the marker alone still links the run.
  assert.deepEqual(parseSession(jsonl(header(), user(first), reply("hi")), "/f.jsonl", new Date(NOW), PATTERN)!.tickets, ["FSDK-5"]);
  // The page shows the message, not the whole context.
  assert.equal(transcriptTurns(raw)[0].text, "[agent-dash context for FSDK-5]\n\nsay hi");
});

test("only a session that is known to be closed resumes", () => {
  const raw = (cwd: string) => parseSession(jsonl(header("s1", cwd), user("go"), reply("done")), "/f.jsonl", new Date(minutesAgo(600)), PATTERN)!;
  const status = (pid: number): ReportedStatus => ({ sessionId: "s1", pid, state: "closed", since: minutesAgo(5) });
  const alive = (pid: number) => pid === 1;
  const idle = { running: false, alive };
  assert.equal(resumeBlocker(undefined, undefined, idle), "no such session");
  assert.equal(resumeBlocker(raw(tmpdir()), status(1), idle), "this session is still running");
  assert.equal(resumeBlocker(raw(tmpdir()), status(2), idle), null);
  // A resume that this server just spawned has no live status file yet.
  assert.equal(resumeBlocker(raw(tmpdir()), status(2), { running: true, alive }), "this session is still running");
  // No status file: a terminal can still have it open, however old the log is.
  assert.match(resumeBlocker(raw(tmpdir()), undefined, idle) ?? "", /terminal still has this session open/);
  assert.match(resumeBlocker(raw("/no/such/folder"), status(2), idle) ?? "", /folder is gone/);
});

test("a resume keeps the session's own name", () => {
  assert.deepEqual(rpcArgs("id-1", { name: "x", resume: { sessionId: "id-1", sessionFile: "/s/a.jsonl" } }), ["--mode", "rpc", "--session", "/s/a.jsonl"]);
});
