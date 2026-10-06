import assert from "node:assert/strict";
import { test } from "node:test";
import type { TicketGroup } from "../shared/types.ts";
import { internalHref, splitTrailing } from "../web/src/links.ts";
import { ciTag, feedback, feedbackCounts, openerRun, panelTarget, verbStart } from "../web/src/prView.ts";
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

/** postman-eng/sdk-gen-fern-platform#172 on 2026-10-06, cut down. */
const pr172 = () => ({
  author: "pgragg",
  lastCommitAt: "2026-10-06T14:11:20Z",
  addressed: [] as string[],
  reviews: [
    { author: "nitpickybot", bot: true, state: "COMMENTED", body: "## AI Review Summary\n\nAdds New Relic APM.", submittedAt: "2026-10-05T23:32:10Z", url: "https://github.com/x/r/pull/172#review-bot" },
    { author: "arielitovsky", bot: false, state: "APPROVED", body: "", submittedAt: "2026-10-06T14:05:20Z", url: "https://github.com/x/r/pull/172#review-1" },
    { author: "arielitovsky", bot: false, state: "APPROVED", body: "Worth taking a look at the nitpicky comment about non-ASCII payloads.", submittedAt: "2026-10-06T14:05:47Z", url: "https://github.com/x/r/pull/172#review-2" },
    // The empty review that GitHub makes for a thread reply.
    { author: "pgragg", bot: false, state: "COMMENTED", body: "", submittedAt: "2026-10-06T14:11:30Z", url: "https://github.com/x/r/pull/172#review-3" },
  ],
  comments: [] as { author: string; bot: boolean; body: string; createdAt: string; url: string }[],
  threads: [
    { path: "log_config.py", line: 94, isOutdated: false, comments: [
      { author: "nitpickybot", bot: true, body: "warning", createdAt: "2026-10-05T23:32:10Z", url: "https://github.com/x/r/pull/172#t1-1" },
      { author: "pgragg", bot: false, body: "The loop always ends", createdAt: "2026-10-06T14:11:30Z", url: "https://github.com/x/r/pull/172#t1-2" },
    ] },
    { path: "log_config.py", line: 85, isOutdated: false, comments: [{ author: "nitpickybot", bot: true, body: "suggestion", createdAt: "2026-10-05T23:32:10Z", url: "https://github.com/x/r/pull/172#t2-1" }] },
    { path: "app.py", line: 3, isOutdated: true, comments: [{ author: "nitpickybot", bot: true, body: "old", createdAt: "2026-10-05T23:32:10Z", url: "https://github.com/x/r/pull/172#t3-1" }] },
  ],
});

test("an approval that asks for a change is to address, even after a commit and a thread reply", () => {
  const f = feedback(pr172());
  // People first, then bots, each newest first. Empty review bodies and the author's own are left out.
  assert.deepEqual(f.map((e) => [e.author, e.kind, e.state]), [
    ["arielitovsky", "review", "to_address"],
    ["nitpickybot", "thread", "replied"],
    ["nitpickybot", "review", "to_address"],
    ["nitpickybot", "thread", "to_address"],
    ["nitpickybot", "thread", "outdated"],
  ]);
  assert.equal(f[0].commitSince, true);
  assert.equal(f[1].key, "https://github.com/x/r/pull/172#t1-2");
  assert.equal(feedbackCounts(f), "3 to address · 1 replied · 1 outdated");
});

test("an author's comment answers what came before it; a local mark addresses one entry until a new reply", () => {
  const d = pr172();
  d.comments.push(
    { author: "rev", bot: false, body: "one more thing", createdAt: "2026-10-06T15:00:00Z", url: "https://github.com/x/r/pull/172#c1" },
    { author: "pgragg", bot: false, body: "done", createdAt: "2026-10-06T15:10:00Z", url: "https://github.com/x/r/pull/172#c2" },
    { author: "rev", bot: false, body: "and this", createdAt: "2026-10-06T15:20:00Z", url: "https://github.com/x/r/pull/172#c3" },
  );
  d.addressed = ["https://github.com/x/r/pull/172#t2-1"];
  const state = (key: string) => feedback(d).find((e) => e.key === key)?.state;
  assert.equal(state("https://github.com/x/r/pull/172#c1"), "replied");
  assert.equal(state("https://github.com/x/r/pull/172#review-2"), "replied");
  assert.equal(state("https://github.com/x/r/pull/172#c3"), "to_address");
  assert.equal(state("https://github.com/x/r/pull/172#c2"), undefined);
  assert.equal(state("https://github.com/x/r/pull/172#t2-1"), "addressed");
  // A new comment in the thread has a new key, so the thread needs an answer again.
  d.threads[1].comments.push({ author: "nitpickybot", bot: true, body: "still?", createdAt: "2026-10-06T16:00:00Z", url: "https://github.com/x/r/pull/172#t2-2" });
  assert.equal(state("https://github.com/x/r/pull/172#t2-2"), "to_address");
  assert.equal(feedbackCounts([]), "");
});
