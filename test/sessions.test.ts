import assert from "node:assert/strict";
import { test } from "node:test";
import { heuristicStatus, parseSession } from "../server/sources/sessions.ts";
import { NOW, PATTERN, header, jsonl, minutesAgo, name, reply, toolCall, toolResult, user } from "./helpers.ts";

const parse = (raw: string, mtimeMinutesAgo = 1) => parseSession(raw, "/f.jsonl", new Date(NOW - mtimeMinutesAgo * 60_000), PATTERN)!;

test("links the ticket the user asked about, not every ticket a tool printed", () => {
  const s = parse(
    jsonl(
      header(),
      user("Fix the double email in FSDK-2046"),
      toolCall("t1", "board"),
      toolResult("t1", "FSDK-1 FSDK-2 FSDK-3 FSDK-4 FSDK-2046"),
      reply("Done. See also FSDK-9 for context."),
    ),
  );
  assert.deepEqual(s.tickets, ["FSDK-2046"]);
});

test("the session name links a ticket, and lowercase branch names count", () => {
  const s = parse(jsonl(header(), name("Work on FSDK-12"), user("go"), toolCall("t1", "git checkout -b fsdk-12-fix"), reply("ok")));
  assert.deepEqual(s.tickets, ["FSDK-12"]);
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
});

test("a ticket named only in passing in many replies does not link the run", () => {
  const replies = Array.from({ length: 10 }, (_, i) => reply(`Status ${i}: FSDK-60 is still overdue.`));
  const s = parse(jsonl(header(), user("build me a dashboard"), ...replies));
  assert.deepEqual(s.tickets, []);
});
