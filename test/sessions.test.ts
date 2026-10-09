import assert from "node:assert/strict";
import { test } from "node:test";
import { heuristicStatus, parseSession } from "../server/sources/sessions.ts";
import { NOW, PATTERN, header, jsonl, minutesAgo, name, reply, toolCall, toolResult, user } from "./helpers.ts";

const parse = (raw: string, mtimeMinutesAgo = 1) => parseSession(raw, "/f.jsonl", new Date(NOW - mtimeMinutesAgo * 60_000), PATTERN)!;

test("a key the user names is only a suggested link, and a ticket a tool printed is not even that", () => {
  const s = parse(
    jsonl(
      header(),
      user("Fix the double email in FSDK-2046"),
      toolCall("t1", "board"),
      toolResult("t1", "FSDK-1 FSDK-2 FSDK-3 FSDK-4 FSDK-2046"),
      reply("Done. See also FSDK-9 for context."),
    ),
  );
  assert.deepEqual(s.tickets, []);
  assert.deepEqual(s.suggestedTickets, ["FSDK-2046"]);
});

test("the session name links a ticket, and lowercase branch names count", () => {
  const s = parse(jsonl(header(), name("Work on FSDK-12"), user("go"), toolCall("t1", "git checkout -b fsdk-12-fix"), reply("ok")));
  assert.deepEqual(s.tickets, ["FSDK-12"]);
});

test("a key in file content does not link the run, but a key in a command does", () => {
  const edit = (id: string, tool: string, args: Record<string, unknown>) => ({
    type: "message",
    message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: tool, arguments: args }] },
  });
  const fixture = 'tickets: ["FSDK-1"]';
  const s = parse(
    jsonl(
      header(),
      user("add a skip button"),
      edit("t1", "write", { path: "/repo/test/a.test.ts", content: fixture }),
      edit("t2", "edit", { path: "/repo/test/a.test.ts", edits: [{ oldText: fixture, newText: fixture }] }),
      toolCall("t3", `python3 - <<'EOF'\ns = s.replace('${fixture}', '')\nEOF`),
      toolCall("t4", `cat > /tmp/x <<EOF\n${fixture}\nEOF\ngit checkout -b fsdk-84-skip`),
      toolCall("t5", "jira issue view FSDK-84"),
      toolCall("t6", 'gh pr create --title "FSDK-84: skip"'),
      reply("ok"),
    ),
  );
  assert.deepEqual(s.tickets, ["FSDK-84"]);
});

test("records the PR that gh pr create returned, and ignores a failed create", () => {
  const s = parse(
    jsonl(
      header(),
      user("open a PR"),
      toolCall("t1", 'gh pr create --title "fix [FSDK-5]"'),
      toolResult("t1", "https://github.com/o/r/pull/42\n"),
      toolCall("t2", "gh pr create --title again"),
      toolResult("t2", "already exists: https://github.com/o/r/pull/41", true),
      reply("Opened https://github.com/o/r/pull/42"),
    ),
  );
  assert.deepEqual(s.createdPrs, ["https://github.com/o/r/pull/42"]);
  assert.ok(s.mentionedPrs.includes("https://github.com/o/r/pull/42"));
});

test("a reply that ends in a question is flagged, and its last line is kept", () => {
  const s = parse(jsonl(header(), user("plan it"), reply("Here is the plan.\n\nShould I start with item 1?")));
  assert.equal(s.askedQuestion, true);
  assert.equal(s.lastReply, "Should I start with item 1?");
  assert.equal(s.midRun, false);
});

test("a log that ends on a tool result is mid-run", () => {
  const s = parse(jsonl(header(), user("go"), toolCall("t1", "sleep 100"), toolResult("t1", "")));
  assert.equal(s.midRun, true);
});

test("skips a half-written last line", () => {
  const s = parse(jsonl(header(), user("go"), reply("ok")) + '{"type":"mess');
  assert.equal(s.userMessageCount, 1);
});

test("heuristic: recent mid-run is working, old mid-run is finished", () => {
  const s = parse(jsonl(header(), user("go"), toolCall("t1", "x")), 2);
  assert.equal(heuristicStatus(s, NOW).status, "working");
  assert.equal(heuristicStatus({ ...s, lastActivityAt: minutesAgo(30) }, NOW).status, "finished");
});

test("heuristic: a finished turn waits for input for a few hours, then counts as finished", () => {
  const s = parse(jsonl(header(), user("go"), reply("done?")), 30);
  assert.equal(heuristicStatus(s, NOW).status, "awaiting_input");
  assert.equal(heuristicStatus({ ...s, lastActivityAt: minutesAgo(5 * 60) }, NOW).status, "finished");
  assert.equal(heuristicStatus(s, NOW, () => false).status, "finished", "its folder is gone");
});

test("tickets named after a report skill starts do not link the session", () => {
  const invoked = parse(jsonl(header(), user('<skill name="daily-progress-report" location="/x">…</skill>\nToday: FSDK-1, FSDK-2'), reply("FSDK-1 shipped")));
  assert.deepEqual([...invoked.tickets, ...invoked.suggestedTickets], []);
  const read = { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/h/.pi/agent/skills/standup-daily-summary/SKILL.md" } }] } };
  assert.deepEqual(parse(jsonl(header(), user("standup please"), read, reply("Yesterday: FSDK-1"), user("add FSDK-2"), reply("ok"))).suggestedTickets, []);
  // Only using the skill counts: a session that edits its SKILL.md still links.
  assert.deepEqual(parse(jsonl(header(), user("FSDK-3: fix ~/.pi/agent/skills/daily-progress-report/SKILL.md"), reply("ok"))).suggestedTickets, ["FSDK-3"]);
  // Work before the report keeps its link.
  const late = parse(jsonl(header(), user("begin work on FSDK-4"), reply("done"), user('<skill name="daily-progress-report" location="/x">…</skill>'), reply("FSDK-5, FSDK-6, FSDK-7 shipped")));
  assert.deepEqual(late.suggestedTickets, ["FSDK-4"]);
});

test("a ticket named only in passing in many replies does not link the run", () => {
  const replies = Array.from({ length: 10 }, (_, i) => reply(`Status ${i}: FSDK-60 is still overdue.`));
  const s = parse(jsonl(header(), user("build me a dashboard"), ...replies));
  assert.deepEqual(s.tickets, []);
});

test("a key in AGENT_DASH_IGNORE_TICKETS (default FSDK-1) never links, in any case", async () => {
  const { config } = await import("../server/config.ts");
  const raw = jsonl(header(), name("FSDK-1 and FSDK-12"), user("fsdk-1, FSDK-12, FSDK-10"));
  const s = parseSession(raw, "/f.jsonl", new Date(NOW), config.ticketPattern)!;
  assert.deepEqual(s.tickets, ["FSDK-12"]);
  assert.deepEqual(s.suggestedTickets, ["FSDK-10"]);
});

test("a run links a ticket only on strong evidence: name, handoff, a branch it made, or a PR it opened", () => {
  const chat = [user("Agent dashboard review. FSDK-2073 is #1 in the queue; look at FSDK-2073 again."), reply("FSDK-2073 ranks first because of this thread.")];
  const weak = parse(jsonl(header(), ...chat));
  assert.deepEqual(weak.tickets, []);
  assert.deepEqual(weak.suggestedTickets, ["FSDK-2073"]);
  // Only checking out, reading or naming a branch is not making it.
  const read = parse(jsonl(header(), ...chat, toolCall("t1", "git checkout fsdk-2073-x && git log fsdk-2073-x"), reply("ok")));
  assert.deepEqual(read.tickets, []);

  const strong = (...lines: Parameters<typeof jsonl>) => parse(jsonl(header(), user("go"), ...lines, reply("ok"))).tickets;
  assert.deepEqual(strong(user("[agent-dash context for FSDK-7]\nsee FSDK-8")), ["FSDK-7"]);
  assert.deepEqual(strong(toolCall("t1", "cd /r && git switch -c fsdk-7-fix")), ["FSDK-7"]);
  assert.deepEqual(strong(toolCall("t1", "git -C /r worktree add -b FSDK-7-fix ../r-7 origin/main")), ["FSDK-7"]);
  assert.deepEqual(strong(toolCall("t1", "git checkout -B 'fsdk-7'")), ["FSDK-7"]);
  assert.deepEqual(strong(toolCall("t1", "gh pr create --base main --title 'FSDK-7: fix' --body 'see FSDK-8'")), ["FSDK-7"]);
  // A strong key also outranks a suggested one, which stays a suggestion.
  const both = parse(jsonl(header(), name("FSDK-7: fix"), user("FSDK-8 FSDK-8"), reply("ok")));
  assert.deepEqual([both.tickets, both.suggestedTickets], [["FSDK-7"], ["FSDK-8"]]);
});
