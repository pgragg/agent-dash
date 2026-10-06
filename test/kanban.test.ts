import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullRequest, SdlcEvent, Ticket, TicketGroup } from "../shared/types.ts";
import { kanbanColumns, type Searchable, searchCards, searchScore, stageOf } from "../web/src/kanban.ts";
import { pr, ticket } from "./helpers.ts";

const group = (t: Partial<Ticket> = {}, prs: PullRequest[] = []): TicketGroup => ({ ticket: ticket(t), runs: [], prs, threads: {} });

const smoketest = (over: Partial<SdlcEvent> = {}): SdlcEvent => ({
  id: 1,
  eventType: "smoketest_execution",
  startedAt: "2026-10-02T10:00:00.000Z",
  finishedAt: null,
  outcome: "passed",
  testDetails: null,
  testResults: null,
  sessionId: null,
  skippedAt: null,
  summary: null,
  prUrl: null,
  channel: null,
  message: null,
  messageUrl: null,
  plannedAt: null,
  stateChanges: null,
  writesSummary: null,
  confirmedAt: null,
  confirmedBy: null,
  planId: null,
  environments: ["localhost"],
  tickets: ["FSDK-1"],
  createdAt: "2026-10-02T10:00:00.000Z",
  ...over,
});

test("a card sits in the column of the furthest stage that its ticket reached", () => {
  assert.equal(stageOf(group(), []), "ideation");
  assert.equal(stageOf(group({}, [pr()]), []), "pr");
  // A local smoketest with no PR still moves the card past the PR column.
  assert.equal(stageOf(group(), [smoketest()]), "local_smoketest");
  assert.equal(stageOf(group({}, [pr()]), [smoketest({ outcome: "failed" })]), "pr");
  assert.equal(stageOf(group({ statusCategory: "done" }), []), "done");
});

test("one column per stage in order, then No ticket; each column keeps the order it is given", () => {
  const cols = kanbanColumns(["a", "b", "c", "d"], (x) => (x === "d" ? null : x === "b" ? "in_beta" : "pr"));
  assert.deepEqual(
    cols.map((c) => c.label),
    ["Ideation", "PR exists", "Local test plan", "Local smoketest", "Review requested", "In Beta", "Beta test plan", "Beta smoketest", "In Prod", "Prod test plan", "Prod smoketest", "Ticket done", "No ticket"],
  );
  assert.deepEqual(cols.find((c) => c.id === "pr")!.items, ["a", "c"]);
  assert.deepEqual(cols.find((c) => c.id === "in_beta")!.items, ["b"]);
  assert.deepEqual(cols.find((c) => c.id === "none")!.items, ["d"]);
});

test("search: a key match outranks any text match, and an exact key outranks a longer one", () => {
  const cards: Record<string, Searchable> = {
    mention: { keys: ["FSDK-9"], text: ["Follow up on FSDK-1502 and AD-1"] },
    ad11: { keys: ["AD-11"], text: ["Kanban search"] },
    ad1: { keys: ["AD-1"], text: ["Read local tickets"] },
    fsdk1502: { keys: ["FSDK-1502"], text: ["Fix the docs build"] },
  };
  const ids = Object.keys(cards);
  const find = (q: string) => searchCards(ids, q, (id) => cards[id]);
  assert.deepEqual(find("fsdk-1502"), ["fsdk1502", "mention"]);
  assert.deepEqual(find("1502"), ["fsdk1502", "mention"]);
  assert.deepEqual(find("AD-1"), ["ad1", "ad11", "mention"]);
  assert.deepEqual(find("KANBAN"), ["ad11"]);
  // Every word must match; the key word still lifts its card.
  assert.deepEqual(find("ad-1 local"), ["ad1"]);
  assert.deepEqual(find("nothing"), []);
  assert.deepEqual(find("  "), ids);
  assert.ok(searchScore(cards.fsdk1502, "fsdk-1502")! > searchScore(cards.mention, "fsdk-1502 follow up on and")!);
});
