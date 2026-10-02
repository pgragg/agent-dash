import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { actionCandidates, keepWhenDown, toActions } from "../server/actions.ts";
import { buildDashboard } from "../server/model.ts";
import * as db from "../server/summaries/db.ts";
import type { PullRequest, Ticket, TicketSummaryState } from "../shared/types.ts";
import { NOW, minutesAgo, pr, ticket } from "./helpers.ts";

db.open(join(mkdtempSync(join(tmpdir(), "agent-dash-actions-")), "test.db"));

const ok = { ok: true };
const sources = { jira: ok, github: ok, sessions: ok };

function build(opts: { prs?: PullRequest[]; tickets?: Ticket[]; summaries?: Record<string, TicketSummaryState>; waiting?: boolean } = {}) {
  return buildDashboard({
    sessions: [
      {
        sessionId: "s-wait", sessionFile: "/f", cwd: "/repo", name: "fix it", firstPrompt: "p", lastReply: "", lastMessage: "", askedQuestion: false,
        startedAt: minutesAgo(400), lastActivityAt: minutesAgo(opts.waiting ? 10 : 300), model: null, lastStopReason: "stop", midRun: false,
        tickets: ["FSDK-1"], createdPrs: [], mentionedPrs: [], userMessageCount: 1,
      },
    ],
    // An extension status makes the run "waiting for you"; without one it is finished.
    reported: opts.waiting ? new Map([["s-wait", { sessionId: "s-wait", pid: process.pid, state: "awaiting_input" as const, since: minutesAgo(10) }]]) : new Map(),
    myTickets: opts.tickets ?? [ticket()],
    otherTickets: [],
    prs: opts.prs ?? [],
    now: NOW,
    recentDays: 14,
    sources,
    extensionInstalled: true,
    summaries: opts.summaries,
    jiraServer: "https://jira",
    isAlive: () => true,
  });
}

const doneSummary = (id: number, ticketKey: string, bodies: string[]): TicketSummaryState => {
  const s = {
    id, ticket: ticketKey, status: "done" as const, requestedAt: minutesAgo(70), generatedAt: minutesAgo(60), summary: "x", error: null,
    steps: bodies.map((body, i) => ({ id: id * 10 + i, summaryId: id, ticket: ticketKey, position: i + 1, body })),
  };
  return { latest: s, lastDone: s };
};

test("signals that need you become actions that link into agent-dash; context-only signals do not", () => {
  const d = build({
    waiting: true,
    prs: [
      pr({ url: "https://github.com/o/r/pull/7", tickets: ["FSDK-1"], checks: "failure" }),
      pr({ url: "https://github.com/o/r/pull/8", tickets: ["FSDK-1"], reviewDecision: "REVIEW_REQUIRED" }),
    ],
  });
  const c = actionCandidates(d);
  const byKind = Object.fromEntries(c.map((a) => [a.kind, a]));
  assert.equal(byKind.ci_failing.target, "pr:o/r/7");
  assert.equal(byKind.ci_failing.key, "ci_failing pr:https://github.com/o/r/pull/7");
  assert.equal(byKind.awaiting_input.target, "r:s-wait");
  assert.equal(byKind.awaiting_input.ticket, "FSDK-1");
  // The healthy PR out for review is the reviewer's move.
  assert.equal(byKind.in_review, undefined);
  for (const a of c) assert.doesNotMatch(a.target, /^https?:/);
});

test("next steps of an open ticket are actions that open the step; a Done ticket's are not", () => {
  const d = build({
    tickets: [ticket({ dueDate: "2026-09-20" }), ticket({ key: "FSDK-2", statusCategory: "done", status: "Done" })],
    summaries: { "FSDK-1": doneSummary(1, "FSDK-1", ["merge it", "tell QA"]), "FSDK-2": doneSummary(2, "FSDK-2", ["old"]) },
  });
  const steps = actionCandidates(d).filter((a) => a.kind === "next_step");
  assert.deepEqual(steps.map((s) => [s.target, s.summary]), [["step:10", "merge it"], ["step:11", "tell QA"]]);
  assert.equal(steps[0].createdAt, minutesAgo(60));
  // Overdue (a signal) ranks above the drafted steps.
  const ranked = toActions(actionCandidates(d), db.syncActions(actionCandidates(d)), d);
  assert.equal(ranked[0].kind, "overdue");
  assert.equal(ranked[0].ticketSummary, "t");
  assert.deepEqual(ranked.slice(1).map((a) => a.summary), ["merge it", "tell QA"]);
});

test("an action keeps its row and age while it lasts, clears when it goes, and comes back as a new row", () => {
  const t0 = new Date(NOW);
  const a = { key: "ci_failing pr:x", kind: "ci_failing", ticket: "FSDK-9" };
  const first = db.syncActions([a], () => false, t0).get(a.key)!;
  assert.equal(first.createdAt, t0.toISOString());
  const again = db.syncActions([a], () => false, new Date(NOW + 60_000)).get(a.key)!;
  assert.deepEqual(again, first);

  // GitHub is down: the PR action is unknown, not gone.
  const down = keepWhenDown({ ...sources, github: { ok: false, error: "timeout" } });
  assert.deepEqual(db.syncActions([], down).get(a.key), first);

  assert.equal(db.syncActions([], () => false).has(a.key), false);
  const back = db.syncActions([a], () => false, new Date(NOW + 120_000)).get(a.key)!;
  assert.notEqual(back.id, first.id);
});

test("a next step's row dates from when its summary was saved", () => {
  const rows = db.syncActions([{ key: "next_step step:99", kind: "next_step", ticket: "FSDK-1", createdAt: minutesAgo(600) }]);
  assert.equal(rows.get("next_step step:99")!.createdAt, minutesAgo(600));
});
