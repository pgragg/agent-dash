import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultDueDate, isDate, moveStepTarget, moveTargets, screenFields } from "../shared/jiraVerbs.ts";

test("a date is a real YYYY-MM-DD day", () => {
  assert.equal(isDate("2026-10-30"), true);
  assert.equal(isDate("next week"), false);
  assert.equal(isDate("2026-13-45"), false);
});

test("the default due date is two weeks out", () => {
  // Local times: late in the evening is still the same day.
  assert.equal(defaultDueDate(new Date(2026, 9, 2, 12)), "2026-10-16");
  assert.equal(defaultDueDate(new Date(2026, 9, 2, 23, 30)), "2026-10-16");
});

test("screen fields echo what the issue holds and fill empty dates", () => {
  const now = new Date(2026, 9, 2, 12);
  const screen = [
    { key: "priority", type: "priority" },
    { key: "customfield_11930", type: "date" },
    { key: "duedate", type: "date" },
    { key: "labels", type: "array" },
    { key: "resolution", type: "resolution" },
  ];
  const issue = { priority: { id: "3", name: "P2", iconUrl: "x" }, customfield_11930: null, duedate: null, labels: ["a"], resolution: null };
  assert.deepEqual(screenFields(screen, issue, now), { priority: { id: "3" }, customfield_11930: "2026-10-02", duedate: "2026-10-16", labels: ["a"] });
});

test("screen fields keep a due date the issue has", () => {
  assert.deepEqual(screenFields([{ key: "duedate", type: "date" }], { duedate: "2026-11-01" }, new Date(2026, 9, 2)), { duedate: "2026-11-01" });
});

const T = moveTargets([{ to: "Review" }, { to: "In Review" }, { to: "Done" }, { to: "In Progress" }], "To Do");

test("a step that moves the ticket to a reachable status names that status", () => {
  assert.equal(moveStepTarget("Piper moves the ticket to In Progress.", "FSDK-1909", T)?.to, "In Progress");
  assert.equal(moveStepTarget("Piper or an agent: move [FSDK-2090](https://postmanlabs.atlassian.net/browse/FSDK-2090) to Done in Jira.", "FSDK-2090", T)?.to, "Done");
  assert.equal(moveStepTarget("An agent moves https://postmanlabs.atlassian.net/browse/FSDK-2081 to Done after FSDK-2091 closes.", "FSDK-2081", T)?.to, "Done");
  assert.equal(moveStepTarget("Piper: move it to **In Review**.", "FSDK-1", T)?.to, "In Review");
});

test("other moves and unreachable statuses get no Move button", () => {
  assert.equal(moveStepTarget("Piper: move the due date to Done.", "FSDK-1", T), null);
  assert.equal(moveStepTarget("Piper: decide where step D lives (move callers, scale fai-chat to 0).", "FSDK-1", T), null);
  assert.equal(moveStepTarget("Piper moves the ticket to Blocked.", "FSDK-1", T), null);
  assert.equal(moveStepTarget("Piper moves FSDK-2 to Done.", "FSDK-1", T), null);
});

test("Backlog reaches In Progress through To Do, and a ticket never moves to its own status", () => {
  const backlog = [{ to: "Deferred" }, { to: "Backlog" }, { to: "To Do" }];
  assert.deepEqual(moveTargets(backlog, "Backlog"), [
    { to: "Deferred", via: null },
    { to: "To Do", via: null },
    { to: "In Progress", via: "To Do" },
  ]);
  assert.deepEqual(moveTargets([{ to: "In Progress" }, { to: "To Do" }], "Backlog"), [
    { to: "In Progress", via: null },
    { to: "To Do", via: null },
  ]);
});
