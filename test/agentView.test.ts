import assert from "node:assert/strict";
import { test } from "node:test";
import { agentBoard, agentRoot, agentRun, agentTicket, MOVE_ALONG_ASK, SKILL_LIMITS, skillMessage, type Origin } from "../shared/agentView.ts";
import { boardSections, buildSubjects } from "../shared/board.ts";
import type { AttentionItem, Dashboard, SdlcEnvironment, SdlcEvent, TicketGroup } from "../shared/types.ts";
import { minutesAgo, NOW, pr, run, ticket } from "./helpers.ts";

const o: Origin = { base: "http://127.0.0.1:7777", full: false };

const signal = (over: Partial<AttentionItem>): AttentionItem => ({ kind: "ci_failing", score: 50, reason: "CI is red", name: "n", status: "CI red", ticketKey: null, ticketUrl: null, since: minutesAgo(10), updatedAt: minutesAgo(10), ...over });
const group = (key: string, over: Partial<TicketGroup> = {}): TicketGroup => ({ ticket: ticket({ key, summary: `Title of ${key}` }), runs: [], prs: [], threads: {}, ...over });

function dashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    generatedAt: new Date(NOW).toISOString(),
    attention: [
      signal({ ticketKey: "FSDK-1", kind: "ci_failing", score: 50, prUrl: "https://github.com/o/r/pull/1" }),
      signal({ ticketKey: "FSDK-2", kind: "overdue", score: 90, reason: "3d late", status: "3d late" }),
      signal({ ticketKey: "FSDK-3", kind: "in_review", score: 10, info: true, reason: "out for review", status: "in review" }),
    ],
    myTickets: [group("FSDK-1", { prs: [pr({ checks: "failure", failedChecks: ["test"], tickets: ["FSDK-1"] })] }), group("FSDK-2", { ticket: ticket({ key: "FSDK-2", dueDate: "2026-09-29" }) }), group("FSDK-3"), group("FSDK-4")],
    otherTickets: [],
    unlinkedRuns: [],
    prs: [],
    counts: { working: 0, awaiting_input: 0, finished: 0 },
    summaries: {},
    notes: {},
    snoozedUntil: {},
    starred: [],
    untilChange: {},
    diagrams: [],
    documents: [],
    sdlcEvents: {},
    reviewDrafts: {},
    conversationSummaries: {},
    reviewRequests: {},
    parked: [],
    sources: { github: { ok: true }, sessions: { ok: true } },
    extensionInstalled: true,
    ...over,
  } as Dashboard;
}

const sectionsOf = (d: Dashboard, marked = new Set<string>()) => {
  const subjects = buildSubjects(d);
  return { subjects, sections: boardSections(d, subjects, NOW, (s) => marked.has(s.id)) };
};
const ids = (b: ReturnType<typeof agentBoard>, id: string) => b.sections.find((s) => s.id === id)!.items.map((i) => ("ref" in i ? i.ref : i.ticket));

test("the board ranks Up next by urgency, and context and quiet tickets go to their own sections", () => {
  const d = dashboard();
  const { sections } = sectionsOf(d);
  const b = agentBoard(d, sections, o);
  assert.deepEqual(ids(b, "up_next"), ["t:FSDK-2", "t:FSDK-1"]);
  assert.deepEqual(ids(b, "waiting_on_others"), ["t:FSDK-3"]);
  assert.deepEqual(ids(b, "quiet"), ["t:FSDK-4"]);
  assert.equal(b.needsYou, 2);
  assert.equal(agentRoot(d, sections, o).counts.needsYou, 2, "the root and the board agree");
});

test("a star leads the queue and shows once; a snooze until a change takes the entry out of Up next", () => {
  const d = dashboard({ starred: ["FSDK-1"] });
  const b = agentBoard(d, sectionsOf(d).sections, o);
  assert.deepEqual(ids(b, "starred"), ["t:FSDK-1"]);
  assert.deepEqual(ids(b, "up_next"), ["t:FSDK-2"]);
  assert.equal(b.needsYou, 2, "a starred entry still counts");

  const marked = agentBoard(d, sectionsOf(d, new Set(["t:FSDK-2"])).sections, o);
  assert.deepEqual(ids(marked, "up_next"), []);
  assert.deepEqual(ids(marked, "until_change"), ["t:FSDK-2"]);
});

test("each board entry links to its page and to its agent-mode detail", () => {
  const d = dashboard();
  const item = agentBoard(d, sectionsOf(d).sections, o).sections.find((s) => s.id === "up_next")!.items[1] as { ui: string; self: string; next: { ui: string } };
  assert.equal(item.ui, "http://127.0.0.1:7777/#/t:FSDK-1");
  assert.equal(item.self, "/api/agent/ticket?key=FSDK-1");
  assert.equal(item.next.ui, "http://127.0.0.1:7777/#/pr:o/r/1", "a PR signal is acted on in the PR panel");
});

test("a ticket's actions carry curl lines, and only writes that people see ask first", () => {
  const d = dashboard({ reviewDrafts: { "https://github.com/o/r/pull/1": { prUrl: "https://github.com/o/r/pull/1", status: "done", text: "PR: fix it https://github.com/o/r/pull/1", error: null, requestedAt: "" } } });
  const { subjects, sections } = sectionsOf(d);
  const t = agentTicket(d, sections, subjects.get("t:FSDK-1")!, o);
  const note = t.actions.find((a) => a.rel === "add_note")!;
  assert.equal(note.askFirst, false);
  assert.equal(note.curl, `curl -s -X POST -H 'X-Agent-Dash: 1' -H 'Content-Type: application/json' 'http://127.0.0.1:7777/api/notes?ticket=FSDK-1' -d '{"body":"<note>"}'`);
  assert.equal(t.actions.find((a) => a.rel === "set_due")!.askFirst, false, "a first due date is routine");
  const review = t.prs[0].actions.find((a) => a.rel === "request_review")!;
  assert.deepEqual([review.effect, review.askFirst], ["slack", true]);
  assert.deepEqual(t.prs[0].failedChecks, ["test"]);

  const late = agentTicket(d, sections, subjects.get("t:FSDK-2")!, o);
  assert.equal(late.actions.find((a) => a.rel === "set_due")!.askFirst, true, "it replaces a date that a person set");
});

test("long texts are cut, and full=1 sends them whole", () => {
  const long = "x".repeat(1000);
  const waiting = run({ sessionId: "w1", status: "awaiting_input", lastReply: long, tickets: ["FSDK-1"], canReply: true });
  const d = dashboard({ myTickets: [group("FSDK-1", { runs: [waiting] })], attention: [signal({ ticketKey: "FSDK-1", kind: "awaiting_input", sessionId: "w1", run: waiting })] });
  const { subjects, sections } = sectionsOf(d);
  const cut = agentTicket(d, sections, subjects.get("t:FSDK-1")!, o).agents[0];
  assert.ok(cut.latest!.length < 300 && cut.latest!.endsWith("…"));
  assert.ok(cut.actions.some((a) => a.rel === "reply"));
  const whole = agentTicket(d, sections, subjects.get("t:FSDK-1")!, { ...o, full: true }).agents[0];
  assert.equal(whole.latest, long);
});

test("the button's agent reads the skill by its path, and the hard limits hold whatever the ask", () => {
  const m = skillMessage("/repo/skills/agent-dash/SKILL.md", "http://127.0.0.1:7777");
  assert.ok(m.startsWith("Read the agent-dash skill at `/repo/skills/agent-dash/SKILL.md`"));
  assert.ok(m.includes("http://127.0.0.1:7777") && m.includes(MOVE_ALONG_ASK) && m.endsWith(SKILL_LIMITS));
  const asked = skillMessage("/s.md", "http://x", "Keep FSDK-1 moving");
  assert.ok(asked.includes("Keep FSDK-1 moving") && !asked.includes(MOVE_ALONG_ASK) && asked.endsWith(SKILL_LIMITS));
  assert.ok(skillMessage("/s.md", "http://x", "  ").includes(MOVE_ALONG_ASK));
  for (const limit of ["Slack", "AWS", "Vault", "Jira", "prod"]) assert.ok(SKILL_LIMITS.includes(limit), limit);
});

test("the button's agent first closes the agents whose ask is already done", () => {
  const close = MOVE_ALONG_ASK.indexOf("First, close the agents");
  assert.ok(close >= 0 && close < MOVE_ALONG_ASK.indexOf("Then go through Starred"));
  for (const rel of ["`resolve`", "`dismiss`", "`end`", "Slack search"]) assert.ok(MOVE_ALONG_ASK.includes(rel), rel);
});

test("only a headless run that waits for input can be ended", () => {
  const rels = (over: Parameters<typeof run>[0]) => agentRun(dashboard(), run(over), o, null).actions.map((a) => a.rel);
  const end = (over: Parameters<typeof run>[0]) => agentRun(dashboard(), run(over), o, null).actions.find((a) => a.rel === "end");
  assert.deepEqual([end({ status: "awaiting_input", headless: true, canReply: true })?.href, end({ status: "awaiting_input", headless: true })?.askFirst], ["/api/conversations/end?session=s1", false]);
  for (const over of [{ status: "working" as const, headless: true }, { status: "finished" as const, headless: true }, { status: "awaiting_input" as const, headless: false }]) assert.ok(!rels(over).includes("end"), JSON.stringify(over));
});

test("a smoketest plan offers its run; a run on an environment past Beta asks first", () => {
  const plan = (id: number, environments: SdlcEnvironment[], confirmedAt: string | null): SdlcEvent =>
    ({ id, eventType: "smoketest_plan", startedAt: minutesAgo(60), finishedAt: null, outcome: null, testDetails: "1. x", testResults: null, sessionId: null, skippedAt: null, plannedAt: minutesAgo(50), stateChanges: null, writesSummary: null, confirmedAt, confirmedBy: confirmedAt && "octocat", planId: null, summary: null, prUrl: null, channel: null, message: null, messageUrl: null, environments, tickets: ["FSDK-1"], createdAt: minutesAgo(60) }) as SdlcEvent;
  const d = dashboard({ sdlcEvents: { "FSDK-1": [plan(1, ["postman_beta"], null), plan(2, ["postman_beta"], minutesAgo(40)), plan(3, ["postman_prod"], minutesAgo(40))] } });
  const { subjects, sections } = sectionsOf(d);
  const [waiting, beta, prod] = agentTicket(d, sections, subjects.get("t:FSDK-1")!, o).smoketests;
  const confirm = waiting.actions[0];
  assert.deepEqual([confirm.rel, confirm.askFirst, confirm.href], ["confirm_and_run", true, "/api/sdlc-events/run?id=1"]);
  assert.ok("note" in confirm.body!, "the runner can pass on its limits");
  assert.deepEqual(beta.actions.map((a) => [a.rel, a.askFirst]), [["run_again", false]]);
  assert.deepEqual(prod.actions.map((a) => [a.rel, a.askFirst]), [["run_again", true]]);
});
