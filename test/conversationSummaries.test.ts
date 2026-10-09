import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { basisOf, requestConversationSummaries, runsToDraft, summariesFor, withTitles } from "../server/conversationSummaries.ts";
import * as db from "../server/summaries/db.ts";
import { gistPrompt, needsNothing, parseGist, waitsOnReview } from "../shared/conversationSummary.ts";
import type { Run } from "../shared/types.ts";
import { run } from "./helpers.ts";

db.open(join(mkdtempSync(join(tmpdir(), "agent-dash-gist-")), "test.db"));

test("the model's three lines are parsed; a reply without one of them is refused", () => {
  assert.deepEqual(parseGist("ABOUT: Fix CI on PR 12\nLATEST: The lint step passes now.\nNEEDS: Nothing"), { about: "Fix CI on PR 12", latest: "The lint step passes now.", needs: "Nothing", title: null });
  assert.deepEqual(parseGist("Sure.\n**ABOUT:** x\n- LATEST: y\nNeeds: \"approve the merge\"")!.needs, "approve the merge");
  assert.equal(parseGist("ABOUT: x\nLATEST: y"), null);
  assert.equal(needsNothing("Nothing."), true);
  assert.equal(needsNothing("None now"), true);
  assert.equal(needsNothing("Approve the merge of PR 12"), false);
  assert.match(gistPrompt("awaiting_input", "USER: hi"), /waits for Piper[\s\S]*<conversation>\nUSER: hi\n<\/conversation>/);
});

test("the prompt's review marker is told apart from a need of Piper's own", () => {
  assert.match(gistPrompt("awaiting_input", ""), /NEEDS: Waiting on review: <the PR>/);
  assert.equal(waitsOnReview("Waiting on review: PR 12"), true);
  assert.equal(waitsOnReview("waiting on a PR approval"), true);
  assert.equal(waitsOnReview("Review the diff of PR 12"), false);
  assert.equal(waitsOnReview("Approve the merge of PR 12"), false);
  assert.equal(waitsOnReview(null), false);
});

test("a run is drafted when it has no summary or a newer message; a working run only when it has none", () => {
  const waiting = run({ sessionId: "a", status: "awaiting_input", lastMessage: "Done. Merge it?" });
  const working = run({ sessionId: "b", status: "working", lastMessage: "Reading files" });
  const silent = run({ sessionId: "c", lastMessage: "" });
  const retry = "2026-10-05T09:55:00.000Z";
  const row = (r: Run, over: Partial<db.ConversationSummaryRow> = {}): [string, db.ConversationSummaryRow] => [
    r.sessionId,
    { sessionId: r.sessionId, status: "done", basis: basisOf(r), about: "x", latest: "y", needs: "z", title: null, error: null, requestedAt: "2026-10-05T10:00:00.000Z", generatedAt: "2026-10-05T10:00:10.000Z", ...over },
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
  // So does the stop: a draft made during work is stale when it waits.
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

test("a run with no name gets a short title with its summary; a later draft without one keeps it", async () => {
  assert.doesNotMatch(gistPrompt("awaiting_input", ""), /TITLE:/);
  assert.match(gistPrompt("awaiting_input", "", true), /four lines[\s\S]*TITLE: <a title for the conversation, at most 8 words/);
  assert.equal(parseGist("ABOUT: a\nLATEST: b\nNEEDS: c")!.title, null);
  assert.equal(parseGist("TITLE: Point the prod parcel at the Postman hosted database now please.\nABOUT: a\nLATEST: b\nNEEDS: c")!.title, "Point the prod parcel at the Postman hosted");
  assert.equal(parseGist("TITLE: Read https://start.1password.com/open/i?a=1\nABOUT: a\nLATEST: b\nNEEDS: c")!.title, "Read [start.1password.com]");

  const r = run({ sessionId: "t1", name: null, status: "awaiting_input", lastMessage: "Which db?" });
  const draft = async () => ({ about: "a", latest: "b", needs: "c", title: "Wiki: database sources of truth" });
  requestConversationSummaries([r], () => "/logs/t1.jsonl", () => {}, draft, new Date("2026-10-05T10:00:00.000Z"));
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(withTitles([{ sessionId: "t1" }, { sessionId: "none" }]).map((s) => s.title).join("|"), "Wiki: database sources of truth|");
  const later = { ...r, lastMessage: "Done." };
  requestConversationSummaries([later], () => "/logs/t1.jsonl", () => {}, async () => ({ about: "a", latest: "d", needs: "c" }), new Date("2026-10-05T10:00:00.000Z"));
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(withTitles([{ sessionId: "t1" }])[0].title, "Wiki: database sources of truth");
});
