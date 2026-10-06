import assert from "node:assert/strict";
import { test } from "node:test";
import { rankAttention } from "../server/attention.ts";
import { approvalCount } from "../shared/ownerApproval.ts";
import { NOW, minutesAgo, pr } from "./helpers.ts";

/** cloud9-terraform-prod#178 on 2026-10-06: one approval, green, but the code-owner rule blocks the merge. */
const blocked = pr({ number: 178, repo: "o/cloud9-terraform-prod", reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED", approvals: 1, toAddress: 1 });

test("an approval that GitHub still blocks waits for the repo owner, not for me", () => {
  const [item] = rankAttention([], [blocked], [], NOW);
  assert.equal(item.kind, "in_review");
  assert.equal(item.status, "1 approval, awaiting approval by repo owner");
  assert.equal(item.reason, "cloud9-terraform-prod#178: 1 approval, awaiting approval by repo owner");
  assert.equal(item.info, true);
});

test("a blocked approval that sat for days asks for a nudge", () => {
  const [item] = rankAttention([], [{ ...blocked, updatedAt: minutesAgo(3 * 24 * 60) }], [], NOW);
  assert.equal(item.kind, "in_review");
  assert.ok(!item.info);
  assert.match(item.reason, /nudge the reviewer/);
});

test("a blocked PR with red CI is about CI, and an approval GitHub lets through is still 'merge it'", () => {
  assert.deepEqual(rankAttention([], [{ ...blocked, checks: "failure" }], [], NOW).map((i) => i.kind), ["ci_failing"]);
  assert.equal(rankAttention([], [{ ...blocked, mergeStateStatus: "CLEAN", toAddress: 0 }], [], NOW)[0].kind, "ready_to_merge");
});

test("approvals count each person's latest review, and not bots", () => {
  const r = (author: string, state: string, bot = false) => ({ author, bot, state });
  assert.equal(approvalCount([r("a", "APPROVED"), r("a", "COMMENTED"), r("b", "APPROVED"), r("b", "DISMISSED"), r("copilot", "APPROVED", true)]), 1);
});
