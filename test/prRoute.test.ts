import assert from "node:assert/strict";
import { test } from "node:test";
import { logTail, parseRef, toDetail } from "../server/routes/pr.ts";
import { contextState, failedCheckNames } from "../server/sources/github.ts";
import { PATTERN } from "./helpers.ts";

test("a PR ref must be owner/repo/number and nothing else", () => {
  assert.deepEqual(parseRef("pgragg/agent-dash/12"), { owner: "pgragg", name: "agent-dash", number: 12 });
  assert.deepEqual(parseRef("o/r.js/1"), { owner: "o", name: "r.js", number: 1 });
  for (const bad of ["", "o/r", "o/r/0", "o/r/12x", "o/../1", "o/./1", "-o/r/1", "o/r/1/2", "o r/x/1", "o/r/-1", "o/r/1;rm", "o/r/1234567890"]) {
    assert.equal(parseRef(bad), null, bad);
  }
});

test("the log tail ends at the last error, without timestamps or colour codes", () => {
  const log = [
    "2026-09-18T18:13:11.0000000Z setup",
    "2026-09-18T18:13:11.1000000Z \u001b[31mtest failed\u001b[0m",
    "2026-09-18T18:13:11.2000000Z ##[error]Process completed with exit code 1.",
    "2026-09-18T18:13:12.0000000Z Post job cleanup.",
    "2026-09-18T18:13:12.1000000Z Cleaning up orphan processes",
    "",
  ].join("\n");
  assert.equal(logTail(log), "setup\ntest failed\n##[error]Process completed with exit code 1.");
  assert.equal(logTail(log, 1), "##[error]Process completed with exit code 1.");
  assert.equal(logTail("a\nb\nc"), "a\nb\nc");
  assert.equal(logTail("x".repeat(50), 40, 10), `…${"x".repeat(10)}`);
});

test("check states are the same words for check runs and status contexts; failing names show once", () => {
  assert.equal(contextState({ name: "a", conclusion: "TIMED_OUT" }), "failure");
  assert.equal(contextState({ name: "a", conclusion: null, status: "IN_PROGRESS" }), "pending");
  assert.equal(contextState({ name: "a", conclusion: "SKIPPED" }), "skipped");
  assert.equal(contextState({ context: "ci/x", state: "ERROR" }), "failure");
  assert.equal(contextState({ context: "ci/x", state: "SUCCESS" }), "success");
  assert.deepEqual(
    failedCheckNames([{ name: "lint", conclusion: "FAILURE" }, { name: "lint", conclusion: "FAILURE" }, { name: "test", conclusion: "SUCCESS" }, { context: "deploy", state: "FAILURE" }]),
    ["lint", "deploy"],
  );
});

test("the panel gets unresolved threads only, every check, and the ticket keys", () => {
  const d = toDetail(
    {
      url: "https://github.com/o/r/pull/3", number: 3, title: "fix FSDK-9", state: "OPEN", isDraft: false, body: "b", baseRefName: "main", headRefName: "fsdk-10-x",
      reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE", additions: 5, deletions: 2, changedFiles: 1, updatedAt: "t",
      author: { login: "me" }, repository: { nameWithOwner: "o/r" },
      reviewRequests: { nodes: [{ requestedReviewer: { login: "rev" } }, { requestedReviewer: { name: "team" } }] },
      latestReviews: { nodes: [{ author: { login: "rev2" }, state: "CHANGES_REQUESTED" }] },
      files: { nodes: [{ path: "a.ts", additions: 5, deletions: 2 }] },
      reviewThreads: { nodes: [
        { isResolved: true, path: "a.ts", line: 1, comments: { nodes: [] } },
        { isResolved: false, isOutdated: false, path: "a.ts", line: null, originalLine: 4, comments: { nodes: [{ author: { login: "rev2" }, body: "why?", createdAt: "c", url: "u" }] } },
      ] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [
        { name: "lint", conclusion: "FAILURE", detailsUrl: "d", databaseId: 42, checkSuite: { app: { slug: "github-actions" } } },
        { name: "wiz", conclusion: "SUCCESS", detailsUrl: "w", databaseId: 43, checkSuite: { app: { slug: "wiz" } } },
        { context: "ci/legacy", state: "PENDING", targetUrl: null },
        {},
      ] } } } }] },
    },
    PATTERN,
    new Date("2026-10-02T12:00:00Z"),
  );
  assert.equal(d.checks, "failure");
  assert.deepEqual(d.checkRuns, [
    { name: "lint", state: "failure", url: "d", jobId: 42 },
    { name: "wiz", state: "success", url: "w" },
    { name: "ci/legacy", state: "pending", url: null },
  ]);
  assert.deepEqual(d.threads, [{ path: "a.ts", line: 4, isOutdated: false, comments: [{ author: "rev2", body: "why?", createdAt: "c", url: "u" }] }]);
  assert.deepEqual(d.requestedReviewers, ["rev", "team"]);
  assert.deepEqual(d.tickets, ["FSDK-9", "FSDK-10"]);
  assert.equal(d.fetchedAt, "2026-10-02T12:00:00.000Z");
});
