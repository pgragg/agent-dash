import assert from "node:assert/strict";
import { test } from "node:test";
import { rankAttention } from "../server/attention.ts";
import { resolveReported } from "../server/sources/status.ts";
import { NOW, minutesAgo, pr, run, ticket } from "./helpers.ts";

const kinds = (items: { kind: string }[]) => items.map((i) => i.kind);

test("a question from a live agent outranks a red CI and an overdue ticket", () => {
  const items = rankAttention(
    [run({ status: "awaiting_input", askedQuestion: true, statusSince: minutesAgo(10), tickets: ["FSDK-1"] })],
    [pr({ checks: "failure" })],
    [ticket({ dueDate: "2026-09-20" })],
    NOW,
  );
  assert.deepEqual(kinds(items), ["awaiting_input", "ci_failing", "overdue"]);
  assert.equal(items[0].ticketKey, "FSDK-1");
});

test("working and finished runs do not ask for attention", () => {
  assert.deepEqual(rankAttention([run({ status: "working" }), run({ status: "finished" })], [], [], NOW), []);
});

test("a guessed wait ranks below an exact one", () => {
  const [exact, guess] = rankAttention(
    [run({ sessionId: "a", status: "awaiting_input", statusSource: "heuristic" }), run({ sessionId: "b", status: "awaiting_input" })],
    [],
    [],
    NOW,
  ).map((i) => i.sessionId);
  assert.deepEqual([exact, guess], ["b", "a"]);
});

test("a tab idle for days sinks below fresh problems", () => {
  const items = rankAttention([run({ status: "awaiting_input", statusSince: minutesAgo(3 * 24 * 60) })], [pr({ checks: "failure" })], [], NOW);
  assert.deepEqual(kinds(items), ["ci_failing", "awaiting_input"]);
});

test("approved and green is ready to merge; a draft's problems weigh half", () => {
  const items = rankAttention([], [pr({ reviewDecision: "APPROVED" }), pr({ url: "u2", isDraft: true, mergeable: "CONFLICTING" })], [], NOW);
  assert.deepEqual(kinds(items), ["ready_to_merge", "merge_conflict"]);
  assert.equal(items[1].score, 40);
});

test("an in-progress ticket with no recent run and no open PR is stalled; a parked one is not", () => {
  const items = rankAttention(
    [run({ tickets: ["FSDK-1"], lastActivityAt: minutesAgo(5 * 24 * 60) })],
    [],
    [ticket(), ticket({ key: "FSDK-2", status: "On Hold" })],
    NOW,
  );
  assert.deepEqual(kinds(items), ["stalled"]);
  assert.equal(items[0].ticketKey, "FSDK-1");
});

test("a reported status from a dead process means finished", () => {
  const s = { sessionId: "x", pid: 1, state: "working" as const, since: minutesAgo(1) };
  assert.equal(resolveReported(s, () => true).status, "working");
  assert.equal(resolveReported(s, () => false).status, "finished");
  assert.equal(resolveReported({ ...s, state: "closed" }, () => true).status, "finished");
});

test("each row's updatedAt comes from its source: run log, PR, or Jira ticket", () => {
  const items = rankAttention(
    [run({ status: "awaiting_input", statusSince: minutesAgo(9), lastActivityAt: minutesAgo(8) })],
    [pr({ checks: "failure", updatedAt: minutesAgo(30) })],
    [ticket({ dueDate: "2026-09-01", updatedAt: minutesAgo(600) })],
    NOW,
  );
  const at = Object.fromEntries(items.map((i) => [i.kind, i.updatedAt]));
  assert.equal(at.awaiting_input, minutesAgo(8));
  assert.equal(at.ci_failing, minutesAgo(30));
  assert.equal(at.overdue, minutesAgo(600));
});
