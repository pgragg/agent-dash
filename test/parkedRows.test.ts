import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParkedRun, ParkReason } from "../shared/types.ts";
import { askKey, askRef, needsYouCount, parkedAsks, parkedNeedsYou, splitParked } from "../web/src/parkedRows.ts";
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

test("a ticket with an Up next entry and a parked ask counts one time", () => {
  const asks = [row("a", "stale", { ticket: "FSDK-1" }), row("b", "over_cap", { ticket: "FSDK-1" })];
  const out = parkedAsks(asks, new Set(["FSDK-1"]), new Set());
  assert.deepEqual(out.inQueue.get("FSDK-1")?.map((p) => p.sessionId), ["a", "b"]);
  assert.deepEqual(out.groups, []);
  assert.equal(needsYouCount(1, out), 1);
});

test("Parked asks: one entry per ticket, one per ask with no ticket, and a snoozed ticket waits", () => {
  const asks = [
    row("a", "stale", { ticket: "FSDK-2", parkedAt: minutesAgo(30) }),
    row("b", "stale", { ticket: "FSDK-2", parkedAt: minutesAgo(20) }),
    row("c", "over_cap", { ticket: "FSDK-3", parkedAt: minutesAgo(10) }),
    row("d", "stale", { ticket: null }),
    row("e", "stale", { ticket: null }),
    row("f", "stale", { ticket: "FSDK-4" }),
    row("g", "stale", { ticket: "FSDK-1" }),
  ];
  const out = parkedAsks(asks, new Set(["FSDK-1"]), new Set(["FSDK-4"]));
  // Newest park first, then the asks with no ticket.
  assert.deepEqual(out.groups.map((g) => [g.key, g.rows.map((p) => p.sessionId)]), [["FSDK-3", ["c"]], ["FSDK-2", ["a", "b"]], [null, ["d", "e"]]]);
  assert.equal(out.entries, 4);
  // Up next has FSDK-1 and two other entries; FSDK-1's ask is in its why list.
  assert.equal(needsYouCount(3, out), 7);
});

test("a Parked asks group has its own board ref", () => {
  assert.equal(askRef("FSDK-2"), "asks:FSDK-2");
  assert.equal(askRef(null), "asks:none");
  assert.equal(askKey("asks:FSDK-2"), "FSDK-2");
  assert.equal(askKey("asks:none"), null);
  assert.equal(askKey("t:FSDK-2"), undefined);
  assert.equal(askKey(null), undefined);
});
