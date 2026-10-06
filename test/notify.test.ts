import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttentionItem, ConversationSummary } from "../shared/types.ts";
import { addUpdate, agentFinished, agentWaitsOnReview, entryOf, entryOfSignal, type Group, groupNotification, isNewSince, needSignals, newSignals, type Pending, pruneSeen, releasePending, runUpdate, SEEN_KEEP_MS, SUMMARY_WAIT_MS, signalUpdate, summaryText } from "../web/src/notify.ts";
import { run } from "./helpers.ts";

const since = "2026-10-05T10:00:00.000Z";
const waiting = run({ sessionId: "s1", status: "awaiting_input", statusSince: since, lastReply: "Done. PR 12 is open.", lastMessage: "Done. PR 12 is open." });
const summary = (o: Partial<ConversationSummary> = {}): ConversationSummary => ({ sessionId: "s1", status: "done", about: "Fix CI", latest: "The lint step passes now.", needs: "Nothing", generatedAt: since, error: null, stale: false, ...o });

test("an agent is finished only when its current summary says it needs nothing", () => {
  assert.equal(agentFinished(waiting, summary()), true);
  assert.equal(agentFinished(waiting, summary({ needs: "Approve the merge of PR 12" })), false);
  // No summary, an old one, or one still in progress: no guess.
  assert.equal(agentFinished(waiting, undefined), false);
  assert.equal(agentFinished(waiting, summary({ stale: true })), false);
  assert.equal(agentFinished(waiting, summary({ status: "in_progress" })), false);
  // An open dialog needs an answer, whatever the summary says.
  assert.equal(agentFinished(run({ ...waiting, dialog: { method: "confirm", title: "Run it?", since } }), summary()), false);
  // A question in the last message needs an answer, also when the summary missed it.
  assert.equal(agentFinished(run({ ...waiting, askedQuestion: true }), summary()), false);
});

test("an agent waits on review only when its current summary says so", () => {
  const review = summary({ needs: "Waiting on review: PR 12" });
  assert.equal(agentWaitsOnReview(waiting, review), true);
  assert.equal(agentFinished(waiting, review), false);
  assert.equal(agentWaitsOnReview(waiting, summary()), false);
  assert.equal(agentWaitsOnReview(waiting, summary({ ...review, stale: true })), false);
  assert.equal(agentWaitsOnReview(run({ ...waiting, dialog: { method: "confirm", title: "Run it?", since } }), review), false);
  assert.equal(summaryText(review), "The lint step passes now.\nWaiting on review: PR 12");
});

test("a held notification is dropped when the agent only waits on a PR review", () => {
  const held = new Map<string, Pending>([["s1", { since, heldAt: 0 }]]);
  const out = releasePending(held, [waiting], { s1: summary({ needs: "Waiting on review: PR 12" }) }, 1000);
  assert.equal(out.send.length, 0);
  assert.equal(out.keep.size, 0);
});

test("the summary text is the latest message, plus the need when there is one", () => {
  assert.equal(summaryText(summary()), "The lint step passes now.");
  assert.equal(summaryText(summary({ needs: "Approve the merge" })), "The lint step passes now.\nNeeds from you: Approve the merge");
  assert.equal(summaryText(summary({ stale: true })), null);
});

test("a held notification goes out when the summary is ready, fails, or the time limit passes", () => {
  const held = (heldAt = 0) => new Map<string, Pending>([["s1", { since, heldAt }]]);
  // Still drafting: keep holding.
  let out = releasePending(held(), [waiting], { s1: summary({ status: "in_progress" }) }, 1000);
  assert.deepEqual(out.send, []);
  assert.equal(out.keep.size, 1);
  // Ready: send.
  out = releasePending(held(), [waiting], { s1: summary() }, 1000);
  assert.deepEqual(out.send, [waiting]);
  assert.equal(out.keep.size, 0);
  // Failed: send, with the last reply.
  out = releasePending(held(), [waiting], { s1: summary({ status: "failed", error: "x" }) }, 1000);
  assert.deepEqual(out.send, [waiting]);
  // A failed draft of an older stop: keep holding.
  assert.equal(releasePending(held(), [waiting], { s1: summary({ status: "failed", stale: true }) }, 1000).send.length, 0);
  // No summary: hold until the time limit, then send.
  assert.equal(releasePending(held(), [waiting], {}, SUMMARY_WAIT_MS - 1).send.length, 0);
  out = releasePending(held(), [waiting], {}, SUMMARY_WAIT_MS);
  assert.deepEqual(out.send, [waiting]);
  // A run with no message never gets a summary: send at once.
  const silent = run({ ...waiting, lastMessage: "" });
  assert.deepEqual(releasePending(held(), [silent], {}, 1000).send, [silent]);
});

test("a held notification is dropped when the run moves on", () => {
  const held = new Map<string, Pending>([["s1", { since, heldAt: 0 }]]);
  assert.equal(releasePending(held, [{ ...waiting, status: "working" }], { s1: summary() }, 1000).send.length, 0);
  assert.equal(releasePending(held, [{ ...waiting, statusSince: "2026-10-05T10:05:00.000Z" }], { s1: summary() }, 1000).send.length, 0);
  assert.equal(releasePending(held, [], { s1: summary() }, 1000).keep.size, 0);
});

test("an agent stop says finished or waiting, and shows the summary, else the last reply", () => {
  assert.deepEqual(runUpdate(waiting, summary()), { key: "agent:s1", title: "Agent finished", line: "A run\nThe lint step passes now." });
  assert.deepEqual(runUpdate(waiting, summary({ needs: "Approve the merge" })), { key: "agent:s1", title: "Agent is waiting on you", line: "A run\nThe lint step passes now.\nNeeds from you: Approve the merge" });
  assert.deepEqual(runUpdate(waiting, undefined), { key: "agent:s1", title: "Agent is waiting on you", line: "A run\nDone. PR 12 is open." });
});

// ---- one notification per board entry ----

const item = (o: Partial<AttentionItem>): AttentionItem => ({ kind: "ci_failing", score: 85, reason: "repo#12: CI is red: lint", name: "repo#12", status: "CI red", ticketKey: "ABC-123", ticketUrl: null, prUrl: "https://github.com/o/repo/pull/12", since, updatedAt: since, ...o });

test("ten agent stops on one ticket make one alert and one notification that counts them", () => {
  const groups = new Map<string, Group>();
  const alerts: boolean[] = [];
  for (let i = 0; i < 10; i++) {
    const r = run({ ...waiting, sessionId: `s${i % 3}`, tickets: ["ABC-123"], name: `Agent ${i % 3}` });
    alerts.push(addUpdate(groups, entryOf(r), "ABC-123 · Fix login", runUpdate(r, undefined)).alert);
  }
  assert.deepEqual(alerts, [true, ...Array(9).fill(false)]);
  assert.equal(groups.size, 1);
  const n = groupNotification(groups.get("t:ABC-123")!);
  assert.equal(n.title, "ABC-123 · Fix login: 10 updates");
  // One line per agent, newest first, at most three.
  assert.equal(n.body.split("\n").length, 3);
  assert.match(n.body.split("\n")[0], /^Agent is waiting on you: Agent 0/);
});

test("four tickets make four notifications", () => {
  const groups = new Map<string, Group>();
  for (const key of ["ABC-1", "ABC-2", "ABC-3", "ABC-4"]) for (let i = 0; i < 10; i++) addUpdate(groups, `t:${key}`, key, signalUpdate(item({ ticketKey: key, prUrl: `https://github.com/o/r/pull/${i}` })));
  assert.equal(groups.size, 4);
});

test("a single update names itself, and more than three say how many more", () => {
  const groups = new Map<string, Group>();
  addUpdate(groups, "t:ABC-123", "ABC-123", signalUpdate(item({})));
  assert.deepEqual(groupNotification(groups.get("t:ABC-123")!), { title: "ABC-123: CI is failing", body: "repo#12: CI is red: lint" });
  for (const n of [13, 14, 15, 16]) addUpdate(groups, "t:ABC-123", "ABC-123", signalUpdate(item({ prUrl: `https://github.com/o/repo/pull/${n}`, reason: `repo#${n}: CI is red` })));
  assert.match(groupNotification(groups.get("t:ABC-123")!).body, /\nand 2 more$/);
});

test("a run with no ticket and a PR with no ticket are their own entries", () => {
  assert.equal(entryOf(run({ sessionId: "s9", tickets: [] })), "r:s9");
  assert.equal(entryOfSignal({ ticketKey: null, prUrl: "https://github.com/o/r/pull/1" }), "p:https://github.com/o/r/pull/1");
});

test("only a new signal that needs you is news", () => {
  const before = needSignals([item({}), item({ kind: "in_review", info: true })]);
  // The first snapshot announces nothing.
  assert.deepEqual(newSignals(null, before), []);
  const after = needSignals([item({}), item({ kind: "merge_conflict" }), item({ kind: "stalled", prUrl: undefined }), item({ kind: "awaiting_input", sessionId: "s1", prUrl: undefined }), item({ kind: "overdue", prUrl: undefined, info: true })]);
  assert.deepEqual(newSignals(before, after).map((a) => a.kind), ["merge_conflict"]);
  // A signal that went away and came back is new again.
  assert.deepEqual(newSignals(needSignals([]), before).map((a) => a.kind), ["ci_failing"]);
});

test("a row is new when it came after your last look, and all rows are new when you never looked", () => {
  assert.equal(isNewSince("2026-10-05T10:00:00Z", "2026-10-05T09:00:00Z"), true);
  assert.equal(isNewSince("2026-10-05T08:00:00Z", "2026-10-05T09:00:00Z"), false);
  assert.equal(isNewSince("2026-10-05T08:00:00Z", null), true);
});

test("old looks drop out of the seen record", () => {
  const now = Date.parse("2026-10-05T10:00:00Z");
  const seen = { "t:ABC-1": new Date(now - 1000).toISOString(), "t:ABC-2": new Date(now - SEEN_KEEP_MS - 1).toISOString() };
  assert.deepEqual(Object.keys(pruneSeen(seen, now)), ["t:ABC-1"]);
});
