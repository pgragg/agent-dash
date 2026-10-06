import assert from "node:assert/strict";
import { test } from "node:test";
import { choosePark, type ParkInput, parkedRow, stillWaiting } from "../server/park.ts";
import type { ConversationSummary, Run } from "../shared/types.ts";
import { minutesAgo, NOW, run } from "./helpers.ts";

const waiting = (id: string, over: Partial<Run> = {}): Run => run({ sessionId: id, status: "awaiting_input", headless: true, statusSince: minutesAgo(60), ...over });
const gist = (id: string, needs: string, over: Partial<ConversationSummary> = {}): ConversationSummary => ({ sessionId: id, status: "done", about: "a", latest: "l", needs, generatedAt: minutesAgo(50), error: null, stale: false, ...over });

function input(runs: Run[], over: Partial<ParkInput> = {}): ParkInput {
  const summaries = Object.fromEntries(runs.map((r) => [r.sessionId, gist(r.sessionId, "A decision on X")]));
  return { runs, summaries, done: new Set(), threads: [], exempt: new Set(), now: NOW, ...over };
}
const reasons = (i: ParkInput) => Object.fromEntries(choosePark(i).map((c) => [c.run.sessionId, c.reason]));

test("an agent whose tickets are all Done or resolved parks", () => {
  const runs = [waiting("a", { tickets: ["FSDK-1"] }), waiting("b", { tickets: ["FSDK-1", "FSDK-2"] }), waiting("c", { tickets: ["FSDK-3"] })];
  const threads = [{ id: 1, ticket: "FSDK-3", sessionId: "c", status: "resolved" as const, reason: null, createdAt: minutesAgo(1) }];
  assert.deepEqual(reasons(input(runs, { done: new Set(["FSDK-1"]), threads })), { a: "ticket_done", c: "ticket_done" });
});

test("an agent that needs nothing, or only a reviewer, parks", () => {
  const runs = [waiting("a"), waiting("b"), waiting("c")];
  const i = input(runs);
  i.summaries.a = gist("a", "Nothing");
  i.summaries.b = gist("b", "Waiting on review: PR 12");
  assert.deepEqual(reasons(i), { a: "needs_nothing", b: "needs_nothing" });
});

test("only the newest agent on a ticket stays, except parallel lanes", () => {
  const runs = [waiting("old", { tickets: ["FSDK-1"], startedAt: minutesAgo(300) }), waiting("mid", { tickets: ["FSDK-1"], startedAt: minutesAgo(200) }), run({ sessionId: "new", status: "working", tickets: ["FSDK-1"], startedAt: minutesAgo(100) })];
  assert.deepEqual(reasons(input(runs)), { old: "superseded", mid: "superseded" });
  assert.deepEqual(reasons(input(runs, { laneSessions: new Set(["old", "mid"]) })), {});
  // A finished newer run does not carry the work on.
  runs[2] = { ...runs[2], status: "finished" };
  assert.deepEqual(reasons(input(runs)), { old: "superseded" });
});

test("an agent idle over a day parks, unless it asked a question", () => {
  const runs = [waiting("a", { statusSince: minutesAgo(25 * 60) }), waiting("b", { statusSince: minutesAgo(25 * 60), askedQuestion: true })];
  assert.deepEqual(reasons(input(runs)), { a: "stale" });
});

test("over the cap, questions and the newest stops stay", () => {
  const runs = [waiting("q", { statusSince: minutesAgo(200), askedQuestion: true }), waiting("old", { statusSince: minutesAgo(190) }), waiting("mid", { statusSince: minutesAgo(100) }), waiting("new", { statusSince: minutesAgo(40) })];
  assert.deepEqual(reasons(input(runs, { cap: 2 })), { old: "over_cap", mid: "over_cap" });
});

test("a run that the dash cannot restart exactly never parks, but counts towards the cap", () => {
  const runs = [
    waiting("tab", { headless: false, tickets: ["FSDK-1"] }),
    waiting("dialog", { dialog: { method: "confirm", title: "ok?", since: minutesAgo(60) }, tickets: ["FSDK-1"] }),
    waiting("guess", { statusSource: "heuristic", tickets: ["FSDK-1"] }),
    waiting("fresh", { statusSince: minutesAgo(5), tickets: ["FSDK-1"] }),
    waiting("resumed", { tickets: ["FSDK-1"] }),
    waiting("drafting", { tickets: ["FSDK-1"] }),
    waiting("ok", { statusSince: minutesAgo(45) }),
  ];
  const i = input(runs, { done: new Set(["FSDK-1"]), exempt: new Set(["resumed"]), cap: 2 });
  i.summaries.drafting = gist("drafting", "x", { status: "in_progress" });
  assert.deepEqual(reasons(i), { ok: "over_cap" });
});

test("the parked row keeps the ask, and a park checks the status file first", () => {
  const r = waiting("a", { tickets: ["FSDK-1"], lastMessage: "Pick A or B?" });
  const row = parkedRow({ run: r, reason: "stale", summary: gist("a", "Pick A or B") }, new Date(NOW));
  assert.equal(row.needs, "Pick A or B");
  assert.equal(row.ticket, "FSDK-1");
  assert.equal(row.lastMessage, "Pick A or B?");
  const status = { sessionId: "a", pid: 1, mode: "rpc", state: "awaiting_input" as const, since: r.statusSince };
  assert.equal(stillWaiting(r, status, () => true), true);
  assert.equal(stillWaiting(r, { ...status, since: minutesAgo(1) }, () => true), false, "a reply since");
  assert.equal(stillWaiting(r, { ...status, mode: undefined }, () => true), false, "a terminal run");
  assert.equal(stillWaiting(r, status, () => false), false, "gone");
});
