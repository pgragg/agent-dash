import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullRequest, SdlcEvent, Ticket, TicketGroup } from "../shared/types.ts";
import { kanbanColumns, stageOf } from "../web/src/kanban.ts";
import { pr, ticket } from "./helpers.ts";

const group = (t: Partial<Ticket> = {}, prs: PullRequest[] = []): TicketGroup => ({ ticket: ticket(t), runs: [], prs, threads: {} });

const smoketest = (over: Partial<SdlcEvent> = {}): SdlcEvent => ({
  id: 1,
  eventType: "smoketest",
  startedAt: "2026-10-02T10:00:00.000Z",
  finishedAt: null,
  outcome: "passed",
  testDetails: null,
  testResults: null,
  skippedAt: null,
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
    ["Ideation", "PR exists", "Local smoketest", "Review requested", "In Beta", "Beta smoketest", "In Prod", "Prod smoketest", "Ticket done", "No ticket"],
  );
  assert.deepEqual(cols.find((c) => c.id === "pr")!.items, ["a", "c"]);
  assert.deepEqual(cols.find((c) => c.id === "in_beta")!.items, ["b"]);
  assert.deepEqual(cols.find((c) => c.id === "none")!.items, ["d"]);
});
