import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDashboard } from "../server/model.ts";
import { countPrs, groupOpenPrs } from "../web/src/prs.ts";
import { NOW, minutesAgo, pr, ticket } from "./helpers.ts";

const ok = { ok: true };
const build = (prs: ReturnType<typeof pr>[], createdPrs: string[] = []) =>
  buildDashboard({
    sessions: [
      {
        sessionId: "s", sessionFile: "/f", cwd: "/repo", name: null, firstPrompt: "p", lastReply: "", lastMessage: "", askedQuestion: false,
        startedAt: minutesAgo(100), lastActivityAt: minutesAgo(90), model: null, lastStopReason: "stop", midRun: false,
        tickets: ["FSDK-2"], createdPrs, mentionedPrs: [], userMessageCount: 1,
      },
    ],
    reported: new Map(),
    myTickets: [ticket(), ticket({ key: "FSDK-2", summary: "two" })],
    otherTickets: [],
    prs,
    now: NOW,
    recentDays: 14,
    sources: { jira: ok, github: ok, sessions: ok },
    extensionInstalled: false,
    jiraServer: "https://jira",
  });

const url = (n: number) => `https://github.com/o/r/pull/${n}`;

test("open PRs group by ticket, most urgent group first; closed PRs and keyless PRs are handled", () => {
  const d = build([
    pr({ url: url(1), tickets: ["FSDK-1"], reviewDecision: "REVIEW_REQUIRED" }),
    pr({ url: url(2), tickets: ["FSDK-2"], checks: "failure" }),
    pr({ url: url(3), tickets: ["FSDK-2"], state: "merged" }),
    pr({ url: url(4), tickets: [] }),
  ]);
  const groups = groupOpenPrs(d);
  assert.deepEqual(
    groups.map((g) => [g.ticket?.key ?? null, g.prs.map((e) => e.pr.url)]),
    [
      ["FSDK-2", [url(2)]],
      ["FSDK-1", [url(1)]],
      [null, [url(4)]],
    ],
  );
  assert.equal(groups[0].prs[0].items[0].kind, "ci_failing");
});

test("a keyless PR takes the ticket of the run that opened it", () => {
  const groups = groupOpenPrs(build([pr({ url: url(5), tickets: [] })], [url(5)]));
  assert.deepEqual(
    groups.map((g) => g.ticket?.key),
    ["FSDK-2"],
  );
});

test("a PR that names two tickets shows under both, and counts once", () => {
  const groups = groupOpenPrs(build([pr({ url: url(6), tickets: ["FSDK-1", "FSDK-2"] })]));
  assert.equal(groups.length, 2);
  assert.equal(countPrs(groups), 1);
});
