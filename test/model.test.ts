import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDashboard } from "../server/model.ts";
import type { ParsedSession } from "../server/sources/sessions.ts";
import { NOW, minutesAgo, pr, ticket } from "./helpers.ts";

function session(over: Partial<ParsedSession>): ParsedSession {
  return {
    sessionId: "s",
    sessionFile: "/f",
    cwd: "/repo",
    name: null,
    firstPrompt: "p",
    lastReply: "",
    askedQuestion: false,
    startedAt: minutesAgo(100),
    lastActivityAt: minutesAgo(90),
    model: null,
    lastStopReason: "stop",
    midRun: false,
    tickets: [],
    createdPrs: [],
    mentionedPrs: [],
    userMessageCount: 1,
    ...over,
  };
}

const ok = { ok: true };
const build = (sessions: ParsedSession[], prs = [pr()], myTickets = [ticket()]) =>
  buildDashboard({
    sessions,
    reported: new Map(),
    myTickets,
    otherTickets: [],
    prs,
    now: NOW,
    recentDays: 14,
    sources: { jira: ok, github: ok, sessions: ok },
    extensionInstalled: false,
    jiraServer: "https://jira",
  });

test("runs sit under their ticket, oldest first", () => {
  const d = build([
    session({ sessionId: "new", tickets: ["FSDK-1"], startedAt: minutesAgo(10) }),
    session({ sessionId: "old", tickets: ["FSDK-1"], startedAt: minutesAgo(500) }),
  ]);
  assert.deepEqual(
    d.myTickets[0].runs.map((r) => r.sessionId),
    ["old", "new"],
  );
});

test("a run inherits the ticket of the PR it opened, and a keyless PR inherits the run's main ticket", () => {
  const d = build(
    [
      session({ sessionId: "a", createdPrs: ["https://github.com/o/r/pull/7"] }),
      session({ sessionId: "b", tickets: ["FSDK-1", "FSDK-9"], createdPrs: ["https://github.com/o/r/pull/8"] }),
    ],
    [pr({ url: "https://github.com/o/r/pull/7", tickets: ["FSDK-1"] }), pr({ url: "https://github.com/o/r/pull/8", tickets: [] })],
  );
  const g = d.myTickets[0];
  assert.deepEqual(g.runs.map((r) => r.sessionId).sort(), ["a", "b"]);
  assert.equal(g.prs.length, 2);
  const nine = d.otherTickets.find((t) => t.ticket.key === "FSDK-9");
  assert.equal(nine?.prs.length, 0);
});

test("unused tabs are dropped; recent runs with no ticket are listed separately", () => {
  const d = build([session({ sessionId: "empty", userMessageCount: 0 }), session({ sessionId: "loose" })]);
  assert.deepEqual(
    d.unlinkedRuns.map((r) => r.sessionId),
    ["loose"],
  );
});

test("a ticket named only by runs becomes an 'other' group with a stub when Jira does not know it", () => {
  const d = build([session({ tickets: ["EFSUP-1"] })]);
  assert.equal(d.otherTickets[0].ticket.key, "EFSUP-1");
  assert.equal(d.otherTickets[0].ticket.summary, "(not found in Jira)");
});
