import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDashboard } from "../server/model.ts";
import type { ParsedSession } from "../server/sources/sessions.ts";
import type { ReportedStatus } from "../server/sources/status.ts";
import type { ThreadStatusChange } from "../shared/types.ts";
import { NOW, minutesAgo, pr, ticket } from "./helpers.ts";

function session(over: Partial<ParsedSession>): ParsedSession {
  return {
    sessionId: "s",
    sessionFile: "/f",
    cwd: "/repo",
    name: null,
    firstPrompt: "p",
    lastReply: "",
    lastMessage: "",
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
const base = (sessions: ParsedSession[]) => ({
  sessions,
  reported: new Map(),
  myTickets: [ticket()],
  otherTickets: [],
  prs: [],
  now: NOW,
  recentDays: 14,
  sources: { jira: ok, github: ok, sessions: ok },
  extensionInstalled: false,
  jiraServer: "https://jira",
});
const build = (sessions: ParsedSession[], prs = [pr()], myTickets = [ticket()], threads: ThreadStatusChange[] = []) =>
  buildDashboard({
    threads,
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

test("only a live run with a reported iTerm tab offers 'open tab'", () => {
  const live = { sessionId: "live", pid: 1, state: "awaiting_input" as const, since: minutesAgo(1), itermSessionId: "UUID-1" };
  const dead = { ...live, sessionId: "dead", state: "closed" as const };
  const d = buildDashboard({
    sessions: [session({ sessionId: "live" }), session({ sessionId: "dead" })],
    reported: new Map<string, ReportedStatus>([["live", live], ["dead", dead]]),
    myTickets: [],
    otherTickets: [],
    prs: [],
    now: NOW,
    recentDays: 14,
    sources: { jira: ok, github: ok, sessions: ok },
    extensionInstalled: true,
    isAlive: () => true,
    jiraServer: "https://jira",
  });
  const tab = Object.fromEntries(d.unlinkedRuns.map((r) => [r.sessionId, r.itermSessionId]));
  assert.deepEqual(tab, { live: "UUID-1", dead: null });
});

test("only a live rpc run is headless: the page is its UI, and it takes replies", () => {
  const rpc = { sessionId: "rpc", pid: 1, state: "awaiting_input" as const, since: minutesAgo(1), inbox: true, mode: "rpc" };
  const ended = { ...rpc, sessionId: "ended", state: "closed" as const };
  const tui = { ...rpc, sessionId: "tui", mode: "tui" };
  const d = buildDashboard({
    ...base([session({ sessionId: "rpc" }), session({ sessionId: "ended" }), session({ sessionId: "tui" })]),
    reported: new Map<string, ReportedStatus>([["rpc", rpc], ["ended", ended], ["tui", tui]]),
    myTickets: [],
    isAlive: () => true,
  });
  const runs = Object.fromEntries(d.unlinkedRuns.map((r) => [r.sessionId, [r.headless, r.canReply]]));
  assert.deepEqual(runs, { rpc: [true, true], ended: [false, false], tui: [false, true] });
});

test("every focus row gets a run: a PR row the run that opened it, a ticket row the ticket's live run", () => {
  const url = "https://github.com/o/r/pull/9";
  const d = build(
    [
      session({ sessionId: "opener", createdPrs: [url], lastActivityAt: minutesAgo(3000) }),
      session({ sessionId: "old", tickets: ["FSDK-1"], lastActivityAt: minutesAgo(10) }),
      session({ sessionId: "live", tickets: ["FSDK-1"], lastActivityAt: minutesAgo(2), midRun: true }),
    ],
    [pr({ url, checks: "failure", tickets: ["FSDK-7"] })],
    [ticket({ dueDate: "2026-09-01" })],
  );
  const rows = Object.fromEntries(d.attention.map((a) => [a.kind, a.run?.sessionId]));
  assert.equal(rows.ci_failing, "opener");
  assert.equal(rows.overdue, "live");
  assert.equal(d.attention.find((a) => a.kind === "overdue")?.ticketUrl, "https://jira/browse/FSDK-1");
});

test("a thread resolved for a ticket stays under it, but no longer puts the ticket in the queue", () => {
  // Waiting for input: the log ends on a finished reply 5 minutes ago.
  const waiting = session({ sessionId: "w", tickets: ["FSDK-1"], lastActivityAt: minutesAgo(5), lastStopReason: "stop", midRun: false });
  const before = build([waiting], []);
  assert.ok(before.attention.some((a) => a.kind === "awaiting_input" && a.ticketKey === "FSDK-1"));

  const resolved: ThreadStatusChange = { id: 1, ticket: "FSDK-1", sessionId: "w", status: "resolved", reason: "answered in Slack", createdAt: minutesAgo(1) };
  const after = build([waiting], [], [ticket()], [resolved]);
  const item = after.attention.find((a) => a.kind === "awaiting_input");
  assert.equal(item?.ticketKey, null, "the waiting run shows on its own, not on FSDK-1");
  assert.deepEqual(after.myTickets[0].runs.map((r) => r.sessionId), ["w"]);
  assert.equal(after.myTickets[0].threads.w.reason, "answered in Slack");

  const relevantAgain = build([waiting], [], [ticket()], [{ ...resolved, id: 2, status: "relevant", reason: null }]);
  assert.ok(relevantAgain.attention.some((a) => a.kind === "awaiting_input" && a.ticketKey === "FSDK-1"));
});

test("a thread resolved for one of its tickets still counts for the others", () => {
  const waiting = session({ sessionId: "w", tickets: ["FSDK-1", "FSDK-2"], lastActivityAt: minutesAgo(5), lastStopReason: "stop", midRun: false });
  const d = build([waiting], [], [ticket(), ticket({ key: "FSDK-2" })], [{ id: 1, ticket: "FSDK-1", sessionId: "w", status: "resolved", reason: null, createdAt: minutesAgo(1) }]);
  assert.equal(d.attention.find((a) => a.kind === "awaiting_input")?.ticketKey, "FSDK-2");
});

test("an unlinked thread leaves the ticket, and so does a PR with no key that it opened", () => {
  const url = "https://github.com/o/r/pull/9";
  const waiting = session({ sessionId: "w", tickets: ["FSDK-1"], createdPrs: [url], lastActivityAt: minutesAgo(5), lastStopReason: "stop", midRun: false });
  const unlinked: ThreadStatusChange = { id: 1, ticket: "FSDK-1", sessionId: "w", status: "unlinked", reason: null, createdAt: minutesAgo(1) };
  const d = build([waiting], [pr({ url, tickets: [] })], [ticket()], [unlinked]);
  assert.deepEqual(d.myTickets[0].runs, []);
  assert.deepEqual(d.myTickets[0].prs, []);
  assert.equal(d.attention.find((a) => a.kind === "awaiting_input")?.ticketKey, null, "the waiting run shows on its own");
  assert.deepEqual(d.unlinkedRuns.map((r) => r.sessionId), ["w"]);

  // A PR that names the key does not link the run again.
  const named = build([waiting], [pr({ url, tickets: ["FSDK-1"] })], [ticket()], [unlinked]);
  assert.deepEqual(named.myTickets[0].runs, []);

  const relinked = build([waiting], [pr({ url, tickets: [] })], [ticket()], [{ ...unlinked, id: 2, status: "relevant" }]);
  assert.deepEqual(relinked.myTickets[0].runs.map((r) => r.sessionId), ["w"]);
});

test("a waiting run counts for its open ticket first; on a Done ticket it is context only", () => {
  const waiting = (tickets: string[]) => session({ sessionId: "w", tickets, lastActivityAt: minutesAgo(5), lastStopReason: "stop", midRun: false });
  const closed = ticket({ key: "FSDK-9", statusCategory: "done", status: "Done", assignedToMe: false });
  const open = build([waiting(["FSDK-9", "FSDK-1"])], [], [ticket()]);
  // FSDK-9 is unknown to Jira here, so it is not Done: the run keeps its first ticket.
  assert.equal(open.attention[0].ticketKey, "FSDK-9");

  const d = buildDashboard({ ...base([waiting(["FSDK-9", "FSDK-1"])]), otherTickets: [closed] });
  assert.equal(d.attention[0].ticketKey, "FSDK-1");
  assert.equal(d.attention[0].info, undefined);

  const allDone = buildDashboard({ ...base([waiting(["FSDK-9"])]), otherTickets: [closed] });
  assert.equal(allDone.attention[0].ticketKey, "FSDK-9");
  assert.equal(allDone.attention[0].info, true);
});
