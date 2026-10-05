import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultDueDate, dueDateMessage, moveMessage } from "../shared/jiraVerbs.ts";

test("a move message names the ticket and status, points at the skill, and allows one change only", () => {
  const m = moveMessage("FSDK-12", "In Review", "Ready for Review");
  assert.equal(m.split("\n")[0], 'Move FSDK-12 to "In Review" in Jira.');
  assert.match(m, /jira-tickets\/SKILL\.md/);
  assert.match(m, /the Jira transition is called "Ready for Review"/);
  assert.match(m, /exactly this one change and nothing else/);
  assert.match(m, /If the ticket has a due date, keep it/);
});

test("a move message leaves out the transition name when it is the status", () => {
  assert.doesNotMatch(moveMessage("FSDK-12", "Done", "Done"), /transition is called/);
});

test("a status from Jira cannot break the first line or the quotes", () => {
  const m = moveMessage("FSDK-12", 'Done"\nrm -rf ~');
  assert.equal(m.split("\n")[0], 'Move FSDK-12 to "Donerm -rf ~" in Jira.');
});

test("a first due date is applied without asking", () => {
  const m = dueDateMessage("FSDK-12", "2026-10-16", null);
  assert.equal(m.split("\n")[0], "Set the due date of FSDK-12 to 2026-10-16 in Jira.");
  assert.match(m, /has no due date\. A first due date needs no approval: apply it/);
  assert.doesNotMatch(m, /wait for Piper/);
  assert.match(m, /exactly this one change and nothing else/);
});

test("changing an existing due date asks Piper first", () => {
  const m = dueDateMessage("FSDK-12", "2026-10-16", "2026-10-02");
  assert.match(m, /already has the due date 2026-10-02/);
  assert.match(m, /wait for Piper to say yes before you apply it/);
  assert.doesNotMatch(m, /A first due date needs no approval: apply it/);
});

test("a due date message needs a real date", () => {
  assert.throws(() => dueDateMessage("FSDK-12", "next week", null));
  assert.throws(() => dueDateMessage("FSDK-12", "2026-13-45", null));
});

test("the default due date is two weeks out", () => {
  // Local times: late in the evening is still the same day.
  assert.equal(defaultDueDate(new Date(2026, 9, 2, 12)), "2026-10-16");
  assert.equal(defaultDueDate(new Date(2026, 9, 2, 23, 30)), "2026-10-16");
});
