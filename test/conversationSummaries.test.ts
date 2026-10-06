import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { basisOf, requestConversationSummaries, runsToDraft, summariesFor } from "../server/conversationSummaries.ts";
import * as db from "../server/summaries/db.ts";
import { gistPrompt, needsNothing, parseGist } from "../shared/conversationSummary.ts";
import type { Run } from "../shared/types.ts";
import { run } from "./helpers.ts";

db.open(join(mkdtempSync(join(tmpdir(), "agent-dash-gist-")), "test.db"));

test("the model's three lines are parsed; a reply without one of them is refused", () => {
  assert.deepEqual(parseGist("ABOUT: Fix CI on PR 12\nLATEST: The lint step passes now.\nNEEDS: Nothing"), { about: "Fix CI on PR 12", latest: "The lint step passes now.", needs: "Nothing" });
  assert.deepEqual(parseGist("Sure.\n**ABOUT:** x\n- LATEST: y\nNeeds: \"approve the merge\"")!.needs, "approve the merge");
  assert.equal(parseGist("ABOUT: x\nLATEST: y"), null);
  assert.equal(needsNothing("Nothing."), true);
  assert.equal(needsNothing("None now"), true);
  assert.equal(needsNothing("Approve the merge of PR 12"), false);
  assert.match(gistPrompt("awaiting_input", "USER: hi"), /waits for Piper[\s\S]*<conversation>\nUSER: hi\n<\/conversation>/);
});

test("a run is drafted when it has no summary or a newer message; a working run only when it has none", () => {
  const waiting = run({ sessionId: "a", status: "awaiting_input", lastMessage: "Done. Merge it?" });
  const working = run({ sessionId: "b", status: "working", lastMessage: "Reading files" });
  const silent = run({ sessionId: "c", lastMessage: "" });
  const retry = "2026-10-05T09:55:00.000Z";
  const row = (r: Run, over: Partial<db.ConversationSummaryRow> = {}): [string, db.ConversationSummaryRow] => [
    r.sessionId,
    { sessionId: r.sessionId, status: "done", basis: basisOf(r), about: "x", latest: "y", needs: "z", error: null, requestedAt: "2026-10-05T10:00:00.000Z", generatedAt: "2026-10-05T10:00:10.000Z", ...over },
  ];
  assert.deepEqual(runsToDraft([waiting, working, silent], new Map(), retry).map((r) => r.sessionId), ["a", "b"]);
  assert.deepEqual(runsToDraft([waiting, working], new Map([row(waiting), row(working)]), retry), []);
  const newer = { ...waiting, lastMessage: "Merged." };
  const busy = { ...working, lastMessage: "Writing tests" };
  assert.deepEqual(runsToDraft([newer, busy], new Map([row(waiting), row(working)]), retry).map((r) => r.sessionId), ["a"]);
  // A draft in progress is left alone until it is stuck.
  assert.deepEqual(runsToDraft([newer], new Map([row(waiting, { status: "in_progress" })]), retry), []);
  assert.deepEqual(runsToDraft([newer], new Map([row(waiting, { status: "in_progress", requestedAt: "2026-10-05T09:00:00.000Z" })]), retry).length, 1);
  // The end of the conversation changes what it needs.
  assert.notEqual(basisOf(waiting), basisOf({ ...waiting, status: "finished" }));
  // So does the stop: a draft made while the agent worked is stale when it waits.
  assert.notEqual(basisOf(waiting), basisOf({ ...waiting, status: "working" }));
});

test("drafts run in the background; a failure keeps the old texts, a new message marks them stale", async () => {
  const r1 = run({ sessionId: "s1", status: "awaiting_input", lastMessage: "PR is open. Review it?" });
  const r2 = run({ sessionId: "s2", status: "awaiting_input", lastMessage: "Which env?" });
  const files = (id: string) => `/logs/${id}.jsonl`;
  let changes = 0;
  const draft = async (r: Run, file: string) => {
    assert.equal(file, `/logs/${r.sessionId}.jsonl`);
    await new Promise((res) => setTimeout(res, 5));
    if (r.lastMessage === "boom") throw new Error("pi exited with code 1");
    return { about: `about ${r.sessionId}`, latest: r.lastMessage, needs: "Review the PR" };
  };
  const now = new Date("2026-10-05T10:00:00.000Z");
  assert.deepEqual(requestConversationSummaries([r1, r2, r1], files, () => changes++, draft, now), ["s1", "s2"]);
  // A second page load while they run starts nothing.
  assert.deepEqual(requestConversationSummaries([r1, r2], files, () => changes++, draft, now), []);
  await new Promise((res) => setTimeout(res, 30));
  let out = summariesFor([r1, r2]);
  assert.deepEqual([out.s1.status, out.s1.about, out.s1.needs, out.s1.stale], ["done", "about s1", "Review the PR", false]);

  const failing = { ...r1, lastMessage: "boom" };
  out = summariesFor([failing]);
  assert.equal(out.s1.stale, true);
  assert.deepEqual(requestConversationSummaries([failing], files, () => changes++, draft, now), ["s1"]);
  await new Promise((res) => setTimeout(res, 20));
  out = summariesFor([failing]);
  assert.deepEqual([out.s1.status, out.s1.about, out.s1.error, out.s1.stale], ["failed", "about s1", "pi exited with code 1", false]);
  // Tried again only after a while.
  assert.deepEqual(requestConversationSummaries([failing], files, () => {}, draft, new Date("2026-10-05T10:01:00.000Z")), []);
  assert.deepEqual(requestConversationSummaries([failing], files, () => {}, draft, new Date("2026-10-05T10:06:00.000Z")), ["s1"]);
  await new Promise((res) => setTimeout(res, 20));
  // A run with no log is not claimed.
  assert.deepEqual(requestConversationSummaries([run({ sessionId: "s3", lastMessage: "x" })], () => null, () => {}, draft, now), []);
  assert.equal(summariesFor([run({ sessionId: "s3" })]).s3, undefined);
  assert.ok(changes >= 4);
});
