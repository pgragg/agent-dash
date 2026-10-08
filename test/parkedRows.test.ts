import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParkedRun, ParkReason } from "../shared/types.ts";
import { parkedNeedsYou, splitParked } from "../web/src/parkedRows.ts";
import { minutesAgo, ticket } from "./helpers.ts";

const row = (sessionId: string, reason: ParkReason, over: Partial<ParkedRun> = {}): ParkedRun => ({ sessionId, ticket: "FSDK-1", name: sessionId, cwd: "/repo", reason, parkedAt: minutesAgo(5), needs: "A decision on X", latest: "l", lastMessage: "m", ...over });

test("only a parked agent with an ask of its own, on an open ticket, could need you", () => {
  assert.equal(parkedNeedsYou(row("a", "stale"), false), true);
  assert.equal(parkedNeedsYou(row("a", "over_cap"), false), true);
  // No summary was ready: the last message can hold a question.
  assert.equal(parkedNeedsYou(row("a", "over_cap", { needs: null }), false), true);
  assert.equal(parkedNeedsYou(row("a", "over_cap"), true), false, "its ticket is Done");
  assert.equal(parkedNeedsYou(row("a", "stale", { needs: "Nothing" }), false), false);
  assert.equal(parkedNeedsYou(row("a", "stale", { needs: "Waiting on review: PR 12" }), false), false);
  for (const reason of ["ticket_done", "resolved", "needs_nothing", "superseded"] as const) assert.equal(parkedNeedsYou(row("a", reason), false), false, reason);
});

test("the split keeps every row, and reads Done from the tickets", () => {
  const parked = [row("a", "stale"), row("b", "ticket_done"), row("c", "over_cap", { ticket: "FSDK-2" }), row("d", "needs_nothing", { needs: "Nothing" })];
  const done = { ticket: ticket({ key: "FSDK-2", statusCategory: "done" }), runs: [], prs: [], threads: {} };
  const { needsYou, rest } = splitParked({ parked, myTickets: [], otherTickets: [done] });
  assert.deepEqual(needsYou.map((p) => p.sessionId), ["a"]);
  assert.deepEqual(rest.map((p) => p.sessionId), ["b", "c", "d"]);
});
