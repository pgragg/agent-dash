import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttentionItem } from "../shared/types.ts";
import { parseHash } from "../web/src/routes.ts";
import { needStep } from "../web/src/needs.ts";

const item = (o: Partial<AttentionItem>): AttentionItem => ({ kind: "awaiting_input", score: 1, reason: "", name: "", status: "", ticketKey: "FSDK-1", ticketUrl: null, since: "", updatedAt: "", ...o });
const step = { id: 5, summaryId: 1, ticket: "FSDK-1", position: 1, body: "do", label: null };

test("#/needs opens the needs-you view", () => {
  assert.deepEqual(parseHash("#/needs"), { view: "needs" });
});

test("each signal leads to the place in agent-dash where you act on it", () => {
  assert.deepEqual(needStep(item({ sessionId: "s1" }), null, "t:FSDK-1"), { label: "Reply to the agent", ref: "r:s1" });
  assert.deepEqual(needStep(item({ kind: "run_error", sessionId: "s1" }), null, "t:FSDK-1"), { label: "Open the agent", ref: "r:s1" });
  assert.deepEqual(needStep(item({ kind: "ci_failing", prUrl: "https://github.com/o/r/pull/7" }), null, "t:FSDK-1"), { label: "Open the PR", ref: "pr:o/r/7" });
  assert.deepEqual(needStep(item({ kind: "overdue" }), null, "t:FSDK-1"), { label: "Set a new due date", ref: "t:FSDK-1" });
  assert.deepEqual(needStep(item({ kind: "stalled" }), step, "t:FSDK-1"), { label: "Open the next step", ref: "step:5" });
  assert.deepEqual(needStep(item({ kind: "stalled" }), null, "t:FSDK-1"), { label: "Draft next steps", ref: "t:FSDK-1" });
  // No ticket: fall back to the entry itself.
  assert.deepEqual(needStep(item({ kind: "merge_conflict", ticketKey: null }), null, "p:x"), { label: "Open on the board", ref: "p:x" });
});
