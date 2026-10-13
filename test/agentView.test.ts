import assert from "node:assert/strict";
import { test } from "node:test";
import { agentBoard, agentRoot, agentTicket, skillMessage, DEFAULT_SKILL_ASK, type Origin } from "../shared/agentView.ts";
import { boardSections, buildSubjects } from "../shared/board.ts";
import type { AttentionItem, Dashboard, TicketGroup } from "../shared/types.ts";
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

test("the button's agent reads the skill by its path, with the default ask or the one given", () => {
  const m = skillMessage("/repo/skills/agent-dash/SKILL.md", "http://127.0.0.1:7777");
  assert.ok(m.startsWith("Read the agent-dash skill at `/repo/skills/agent-dash/SKILL.md`"));
  assert.ok(m.includes("http://127.0.0.1:7777") && m.endsWith(DEFAULT_SKILL_ASK));
  assert.ok(skillMessage("/s.md", "http://x", "Keep FSDK-1 moving").endsWith("Keep FSDK-1 moving"));
  assert.ok(skillMessage("/s.md", "http://x", "  ").endsWith(DEFAULT_SKILL_ASK));
});
