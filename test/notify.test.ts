import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationSummary } from "../shared/types.ts";
import { agentFinished, notificationFor, type Pending, releasePending, SUMMARY_WAIT_MS, summaryText } from "../web/src/notify.ts";
import { run } from "./helpers.ts";

const since = "2026-10-05T10:00:00.000Z";
const waiting = run({ sessionId: "s1", status: "awaiting_input", statusSince: since, lastReply: "Done. PR 12 is open." });
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
  // No summary after the time limit: send.
  out = releasePending(held(), [waiting], {}, SUMMARY_WAIT_MS);
  assert.deepEqual(out.send, [waiting]);
});

test("a held notification is dropped when the run moves on", () => {
  const held = new Map<string, Pending>([["s1", { since, heldAt: 0 }]]);
  assert.equal(releasePending(held, [{ ...waiting, status: "working" }], { s1: summary() }, 1000).send.length, 0);
  assert.equal(releasePending(held, [{ ...waiting, statusSince: "2026-10-05T10:05:00.000Z" }], { s1: summary() }, 1000).send.length, 0);
  assert.equal(releasePending(held, [], { s1: summary() }, 1000).keep.size, 0);
});

test("the notification says finished or waiting, and shows the summary, else the last reply", () => {
  assert.deepEqual(notificationFor(waiting, summary()), { title: "Agent finished: A run", body: "The lint step passes now." });
  assert.deepEqual(notificationFor(waiting, summary({ needs: "Approve the merge" })), { title: "Agent is waiting on you: A run", body: "The lint step passes now.\nNeeds from you: Approve the merge" });
  assert.deepEqual(notificationFor(waiting, undefined), { title: "Agent is waiting on you: A run", body: "Done. PR 12 is open." });
});
