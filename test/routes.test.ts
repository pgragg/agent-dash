import assert from "node:assert/strict";
import { test } from "node:test";
import { prRef } from "../shared/refs.ts";
import type { TicketGroup } from "../shared/types.ts";
import { href, humanAge, parseHash, resolveBoardRef } from "../web/src/routes.ts";
import { NOW, minutesAgo, run, ticket } from "./helpers.ts";

test("each kind of hash opens its view", () => {
  // An unknown hash, such as a link to the old Actions view, opens the board.
  assert.equal(parseHash("#/actions").view, "board");
  assert.equal(parseHash("#/a:12").view, "board");
  assert.deepEqual(parseHash("#/pr:o/r/7"), { view: "prs", pr: "pr:o/r/7" });
  assert.deepEqual(parseHash("#/prs"), { view: "prs", pr: null });
  assert.deepEqual(parseHash("#/c:abc"), { view: "conversation", id: "abc" });
  assert.deepEqual(parseHash("#/step:4"), { view: "board", ref: "step:4" });
  assert.deepEqual(parseHash("#/doc:8"), { view: "document", id: 8 });
  // A diagram is a document now: older links open the documents.
  assert.deepEqual(parseHash("#/documents"), { view: "documents" });
  assert.deepEqual(parseHash("#/diagrams"), { view: "documents" });
  assert.deepEqual(parseHash("#/d:12"), { view: "diagram", id: 12 });
  // Old links escaped the colon.
  assert.deepEqual(parseHash("#/t%3AFSDK-1"), { view: "board", ref: "t:FSDK-1" });
  assert.equal(href("pr:o/r/7"), "#/pr:o/r/7");
  assert.deepEqual(parseHash(href("t:FSDK-1")), { view: "board", ref: "t:FSDK-1" });
  assert.equal(prRef("https://github.com/o/r/pull/7"), "pr:o/r/7");
});

test("a run, step, or note opens its ticket on the board and points at itself", () => {
  const g: TicketGroup = { ticket: ticket(), runs: [run({ sessionId: "s9", tickets: ["FSDK-1"] })], prs: [], threads: {} };
  const step = { id: 5, summaryId: 1, ticket: "FSDK-1", position: 1, body: "do" };
  const summary = { id: 1, ticket: "FSDK-1", status: "done" as const, requestedAt: "", generatedAt: "", summary: "", error: null, steps: [step] };
  const d = { myTickets: [g], otherTickets: [], summaries: { "FSDK-1": { latest: summary, lastDone: summary } }, notes: { "FSDK-1": [{ id: 3, ticket: "FSDK-1", createdAt: "", body: "n" }] } };
  const subjects = new Set(["t:FSDK-1", "r:lonely"]);
  assert.deepEqual(resolveBoardRef("r:s9", d, subjects), { subjectId: "t:FSDK-1", anchor: "r:s9" });
  assert.deepEqual(resolveBoardRef("r:lonely", d, subjects), { subjectId: "r:lonely", anchor: null });
  assert.deepEqual(resolveBoardRef("step:5", d, subjects), { subjectId: "t:FSDK-1", anchor: "step:5" });
  assert.deepEqual(resolveBoardRef("note:3", d, subjects), { subjectId: "t:FSDK-1", anchor: "note:3" });
  assert.equal(resolveBoardRef("r:gone", d, subjects), null);
});

test("ages read as words", () => {
  assert.equal(humanAge(minutesAgo(0), NOW), "just now");
  assert.equal(humanAge(minutesAgo(1), NOW), "1 minute");
  assert.equal(humanAge(minutesAgo(180), NOW), "3 hours");
  assert.equal(humanAge(minutesAgo(60 * 24 * 9), NOW), "1 week");
});
