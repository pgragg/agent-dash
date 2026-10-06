import assert from "node:assert/strict";
import { test } from "node:test";
import type { SdlcEvent } from "../shared/types.ts";
import { smoketestRow } from "../web/src/smoketestRow.ts";

let nextId = 1;
function ev(over: Partial<SdlcEvent> = {}): SdlcEvent {
  return {
    id: nextId++,
    eventType: "smoketest_plan",
    startedAt: "2026-10-02T10:00:00.000Z",
    finishedAt: null,
    outcome: null,
    testDetails: "the plan",
    testResults: null,
    sessionId: "s1",
    skippedAt: null,
    summary: "Check the APM records",
    prUrl: null,
    channel: null,
    message: null,
    messageUrl: null,
    plannedAt: "2026-10-02T10:05:00.000Z",
    stateChanges: "deploy x",
    writesSummary: "Postman Prod: one test event",
    confirmedAt: null,
    confirmedBy: null,
    planId: null,
    environments: ["postman_prod"],
    tickets: ["FSDK-1"],
    createdAt: "2026-10-02T10:00:00.000Z",
    ...over,
  };
}

const idle = { asked: false, finished: false };

test("a run with no smoketest event stays an agent row", () => {
  assert.equal(smoketestRow("other", [ev()], idle), null);
  assert.equal(smoketestRow(undefined, [ev()], idle), null);
});

test("a plan that waits for Confirm shows its writes, with Confirm", () => {
  const plan = ev();
  const row = smoketestRow("s1", [plan], idle)!;
  assert.equal(row.title, "Prod plan waits for your Confirm");
  assert.equal(row.detail, "Postman Prod: one test event");
  assert.equal(row.action, "confirm");
  assert.equal(row.plan, plan);
  assert.ok(row.needsYou);
});

test("a plan still in writing, with a question, asks for a Reply", () => {
  const row = smoketestRow("s1", [ev({ plannedAt: null, environments: ["postman_beta"] })], { asked: true, finished: false })!;
  assert.equal(row.title, "Beta plan: the agent asked you a question");
  assert.equal(row.action, "reply");
  assert.ok(row.needsYou);
});

test("the run of a plan in the same session decides the row: passed is news", () => {
  const plan = ev({ environments: ["localhost"], confirmedAt: "2026-10-02T10:06:00.000Z", confirmedBy: "auto" });
  const run = ev({ eventType: "smoketest_execution", environments: ["localhost"], planId: plan.id, outcome: "passed", finishedAt: "2026-10-02T10:20:00.000Z", summary: "Publish flow works" });
  const row = smoketestRow("s1", [plan, run], { asked: false, finished: true })!;
  assert.equal(row.title, "Localhost passed");
  assert.equal(row.detail, "Publish flow works");
  assert.equal(row.needsYou, false);
  assert.equal(row.action, null);
  // The agent still asks for something after the pass, so the row keeps a Reply.
  const asks = smoketestRow("s1", [plan, run], idle)!;
  assert.equal(asks.action, "reply");
  assert.ok(asks.needsYou);
});

test("a blocked run needs you, with Run again on its plan", () => {
  const plan = ev({ confirmedAt: "2026-10-02T10:06:00.000Z", confirmedBy: "piper" });
  const run = ev({ eventType: "smoketest_execution", planId: plan.id, outcome: "blocked", finishedAt: "2026-10-02T10:20:00.000Z" });
  const row = smoketestRow("s1", [run, plan], { asked: false, finished: true })!;
  assert.equal(row.title, "Prod blocked");
  assert.equal(row.action, "run_again");
  assert.equal(row.plan, plan);
  assert.ok(row.needsYou);
});

test("a run still going, where the agent waits, asks for a Reply", () => {
  const plan = ev({ confirmedAt: "2026-10-02T10:06:00.000Z", confirmedBy: "piper" });
  const run = ev({ eventType: "smoketest_execution", planId: plan.id });
  assert.equal(smoketestRow("s1", [plan, run], idle)!.title, "Prod smoketest: the agent waits for you");
});
