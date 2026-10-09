import assert from "node:assert/strict";
import { test } from "node:test";
import type { Dashboard, TicketDocument } from "../shared/types.ts";
import { parseHash } from "../web/src/routes.ts";
import { tabTitle } from "../web/src/tabTitle.ts";
import { pr, run } from "./helpers.ts";

const url = (n: number) => `https://github.com/o/r/pull/${n}`;
const data = (over: Partial<Dashboard> = {}) => ({
  prs: [],
  documents: [],
  counts: { working: 0, awaiting_input: 0, finished: 0 },
  myTickets: [],
  otherTickets: [],
  unlinkedRuns: [],
  ...over,
});
const title = (hash: string, d = data(), needsYou = 0, open: string | null = null) => tabTitle({ route: parseHash(hash), data: d, needsYou, open });

test("the board gives the top bar's Needs you count, then the entry that is open", () => {
  assert.equal(title("#/", data(), 3, "Fix the login redirect"), "Board (3) · Fix the login redirect · agent-dash");
  assert.equal(title("#/", data()), "Board · agent-dash");
  // One count of work: a waiting agent with no entry in Up next or Parked asks does not add to it.
  assert.equal(title("#/", data({ counts: { working: 0, awaiting_input: 2, finished: 0 } })), "Board · agent-dash");
  // The old Notifications address is the board now.
  assert.equal(title("#/needs", data(), 3), "Board (3) · agent-dash");
  assert.equal(title("#/", data(), 0, "A very long ticket title that goes on and on past the limit"), "Board · A very long ticket title that goes on a… · agent-dash");
});

test("the PRs view counts the open PRs, then the approved, with feedback, and red ones", () => {
  const prs = [
    pr({ url: url(1), reviewDecision: "APPROVED" }),
    pr({ url: url(2), reviewDecision: "APPROVED", toAddress: 2 }),
    pr({ url: url(3), reviewDecision: "CHANGES_REQUESTED", checks: "failure" }),
    pr({ url: url(4) }),
    pr({ url: url(5), state: "merged", reviewDecision: "APPROVED" }),
  ];
  assert.equal(title("#/prs", data({ prs })), "PRs 4 · 2✓ 2💬 1✗ · agent-dash");
  assert.equal(title("#/prs", data({ prs: [pr()] })), "PRs 1 · agent-dash");
  assert.equal(title("#/prs", data()), "PRs · agent-dash");
});

test("a PR's panel gives its state and title, or its repo and number when it is not on the board", () => {
  const prs = [pr({ url: url(7), title: "Fix the login redirect", reviewDecision: "APPROVED", toAddress: 2, checks: "failure" }), pr({ url: url(8), title: "Old", state: "merged" })];
  assert.equal(title("#/pr:o/r/7", data({ prs })), "PR ✓ 💬2 ✗ · Fix the login redirect · agent-dash");
  assert.equal(title("#/pr:o/r/8", data({ prs })), "PR merged · Old · agent-dash");
  assert.equal(title("#/pr:o/r/9", data({ prs })), "PR · o/r#9 · agent-dash");
});

test("a conversation gives its status and name; the other views give their counts", () => {
  const d = data({
    unlinkedRuns: [run({ sessionId: "s1", name: "Deploy FDR", status: "awaiting_input" })],
    counts: { working: 1, awaiting_input: 1, finished: 4 },
    documents: [{ id: 4, title: "How login works" } as TicketDocument],
  });
  assert.equal(title("#/c:s1", d), "✋ Deploy FDR · agent-dash");
  assert.equal(title("#/c:s2", data({ unlinkedRuns: [run({ sessionId: "s2", name: "Bump fai", status: "working" })] })), "⚙️ Bump fai · agent-dash");
  assert.equal(title("#/c:s3", data({ unlinkedRuns: [run({ sessionId: "s3", name: "Old run" })] })), "Old run · agent-dash");
  assert.equal(title("#/c:gone", d), "Chat · agent-dash");
  assert.equal(title("#/c", d), "New chat · agent-dash");
  assert.equal(title("#/history", d), "History 2 live · agent-dash");
  assert.equal(title("#/documents", d), "Documents 1 · agent-dash");
  assert.equal(title("#/doc:4", d), "Doc · How login works · agent-dash");
  assert.equal(title("#/settings", d), "Settings · agent-dash");
  assert.equal(tabTitle({ route: parseHash("#/prs"), data: null, needsYou: 0, open: null }), "agent-dash");
});

test("an agent that only waits on a PR review is not waiting on you in the tab title", () => {
  const needs = (n: string) => ({ s1: { sessionId: "s1", status: "done", about: "a", latest: "PR is open.", needs: n, generatedAt: "", error: null, stale: false } as const });
  const d = data({ unlinkedRuns: [run({ sessionId: "s1", name: "Deploy FDR", status: "awaiting_input" })], counts: { working: 0, awaiting_input: 1, finished: 0 } });
  assert.equal(title("#/c:s1", { ...d, conversationSummaries: needs("Waiting on review: PR 12") }), "👀 Deploy FDR · agent-dash");
});
