import assert from "node:assert/strict";
import { test } from "node:test";
import type { TicketGroup } from "../shared/types.ts";
import { internalHref, splitTrailing } from "../web/src/links.ts";
import { ciTag, openerRun, panelTarget, verbStart } from "../web/src/prView.ts";
import { minutesAgo, run, ticket } from "./helpers.ts";

const url = "https://github.com/o/r/pull/7";

test("a PR link opens the PR panel, a known Jira key opens the ticket, anything else stays external", () => {
  const known = new Set(["FSDK-1"]);
  assert.equal(internalHref(url, known), "#/pr:o/r/7");
  assert.equal(internalHref(`${url}/files#diff-1`, known), "#/pr:o/r/7");
  assert.equal(internalHref("https://postmanlabs.atlassian.net/browse/FSDK-1", known), "#/t:FSDK-1");
  assert.equal(internalHref("https://postmanlabs.atlassian.net/browse/FSDK-2", known), null);
  assert.equal(internalHref("https://github.com/o/r/issues/7", known), null);
  assert.equal(internalHref("https://example.com/?u=github.com/o/r/pull/7", known), null);
  // Any Jira host: JIRA_SERVER can point anywhere.
  assert.equal(internalHref("https://jira.example.com/browse/FSDK-1?focusedCommentId=3", known), "#/t:FSDK-1");
  assert.equal(internalHref("https://jira.example.com/browse/FSDK-12", known), null);
});

test("a sentence's full stop after a bare URL stays text", () => {
  assert.deepEqual(splitTrailing(`${url}.`), { url, trailing: "." });
  assert.deepEqual(splitTrailing(`${url}),`), { url: `${url})`, trailing: "," });
  assert.deepEqual(splitTrailing(url), { url, trailing: "" });
});

test("the CI tag names the failing checks, and a PR address must be owner/repo/number", () => {
  assert.deepEqual(ciTag({ checks: "failure", failedChecks: ["lint", "test", "build"] }), { text: "CI failure: lint, test, +1 more", tone: "bad", title: "lint\ntest\nbuild" });
  assert.deepEqual(ciTag({ checks: "failure" }), { text: "CI failure", tone: "bad" });
  assert.deepEqual(ciTag({ checks: "pending", failedChecks: ["x"] }), { text: "CI pending", tone: "warn" });
  assert.equal(ciTag({ checks: "none" }), null);
  assert.deepEqual(panelTarget("pr:o/r/7"), { path: "o/r/7", url });
  for (const bad of ["pr:", "pr:o/r", "pr:o/r/x", "pr:o/r/7/files"]) assert.equal(panelTarget(bad), null, bad);
});

const group = (over: Partial<TicketGroup> = {}): TicketGroup => ({ ticket: ticket(), runs: [], prs: [], threads: {}, ...over });

test("a verb starts in the folder of the run that opened the PR, on a ticket the board knows", () => {
  const opener = run({ sessionId: "op", cwd: "/Users/me/src/r", createdPrs: [url], lastActivityAt: minutesAgo(50) });
  const later = run({ sessionId: "late", cwd: "/elsewhere", lastActivityAt: minutesAgo(1) });
  const d = { myTickets: [group({ runs: [opener, later] })], otherTickets: [], unlinkedRuns: [] };
  assert.equal(openerRun(d, url)?.sessionId, "op");
  assert.deepEqual(verbStart(d, { url, tickets: ["FSDK-1"] }), { ticket: "FSDK-1", cwd: "~/src/r" });
  // A key the board does not know cannot start a ticket agent; it becomes a conversation.
  assert.deepEqual(verbStart(d, { url, tickets: ["FSDK-99"] }), { ticket: null, cwd: "~/src/r" });
});

test("with no opener, a verb takes the ticket's newest relevant folder, else home", () => {
  const old = run({ sessionId: "a", cwd: "/repo/a", lastActivityAt: minutesAgo(30) });
  const newest = run({ sessionId: "b", cwd: "/repo/b", lastActivityAt: minutesAgo(1) });
  const resolved = { b: { id: 1, ticket: "FSDK-1", sessionId: "b", status: "resolved" as const, reason: null, createdAt: "" } };
  const d = (threads = {}) => ({ myTickets: [group({ runs: [old, newest], threads })], otherTickets: [], unlinkedRuns: [] });
  assert.deepEqual(verbStart(d(), { url, tickets: [] }, "FSDK-1"), { ticket: "FSDK-1", cwd: "/repo/b" });
  assert.deepEqual(verbStart(d(resolved), { url, tickets: ["FSDK-1"] }), { ticket: "FSDK-1", cwd: "/repo/a" });
  assert.deepEqual(verbStart({ myTickets: [], otherTickets: [], unlinkedRuns: [] }, { url, tickets: [] }), { ticket: null, cwd: "~" });
});
