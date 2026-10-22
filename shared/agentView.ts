import { type BoardSections, firstStep, lead, liveRuns, needLine, relevantRuns, type Subject, subjectTitle } from "./board.ts";
import { readySummary } from "./notify.ts";
import { needStep } from "./needs.ts";
import { prRef } from "./refs.ts";
import { autoRunAllowed, environments, isPlanWaiting, sdlcProgress } from "./sdlc.ts";
import type { Dashboard, ParkedRun, PullRequest, Run, SdlcEvent } from "./types.ts";

/**
 * Agent mode: the board as small, typed JSON for a coding agent that drives agent-dash. Each
 * object says what an agent can do next with it (`actions`), and where Piper sees it (`ui`).
 * `/api/dashboard` is the page's data, about 2 MB; these answers stay at a few KB.
 */

export const AGENT_SCHEMA = "agent-dash/agent/v1";

/** Long texts are cut to this, so a board of 20 entries stays small. `?full=1` sends them whole. */
const CUT = 240;

/** Where the request came from: the curl lines and the page links use the same host. */
export interface Origin {
  /** "http://127.0.0.1:7777", or the HTTPS name that a proxy gave. */
  base: string;
  full: boolean;
}

/** What a write changes: only this machine, or a tracker or Slack that other people read. */
export type Effect = "local" | "tracker" | "slack";

/** One thing an agent can do: the request, and a curl line that works as printed once the <placeholders> are filled. */
export interface AgentAction {
  rel: string;
  title: string;
  method: "GET" | "POST";
  href: string;
  body?: Record<string, unknown>;
  effect: Effect;
  /** Ask the person first: the write is seen by other people, or replaces what they set. */
  askFirst: boolean;
  curl: string;
}

/** The board lists many entries, so its texts are shorter than a ticket's. */
const CUT_LIST = 160;

const cut = (o: Origin, s: string | null | undefined, max = CUT): string | null => {
  if (!s) return null;
  const t = s.trim();
  return o.full || t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

const q = encodeURIComponent;
const ui = (o: Origin, ref: string) => `${o.base}/#/${ref}`;

function action(o: Origin, rel: string, title: string, href: string, opts: { body?: Record<string, unknown>; effect?: Effect; askFirst?: boolean; method?: "GET" | "POST" } = {}): AgentAction {
  const method = opts.method ?? "POST";
  const body = opts.body;
  // Placeholders hold no single quote, so the body fits in one shell-quoted argument.
  const curl =
    method === "GET"
      ? `curl -s '${o.base}${href}'`
      : `curl -s -X POST -H 'X-Agent-Dash: 1' -H 'Content-Type: application/json' '${o.base}${href}'${body ? ` -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'` : ""}`;
  return { rel, title, method, href, ...(body && { body }), effect: opts.effect ?? "local", askFirst: opts.askFirst ?? false, curl };
}

// ---- root -----------------------------------------------------------------------------

export function agentRoot(d: Dashboard, sections: BoardSections, o: Origin) {
  return {
    schema: AGENT_SCHEMA,
    generatedAt: d.generatedAt,
    counts: { needsYou: sections.needsYou, waiting: d.counts.awaiting_input, working: d.counts.working },
    sources: Object.fromEntries(Object.entries(d.sources).map(([k, s]) => [k, s.off ? "off" : s.ok ? "ok" : `down: ${s.error ?? "unknown"}`])),
    setup: d.setup ?? [],
    rules: [
      "Every POST needs the header `X-Agent-Dash: 1`. Each action has a curl line that sends it.",
      "An action with askFirst: true writes where other people see it, or replaces what a person set. Show the person the exact change, and wait for a yes.",
      "Give the person the `ui` link of each object that you name, so they can open it on the page.",
      "Long texts are cut. Add `full=1` to a GET to read them whole.",
    ],
    links: {
      board: "/api/agent/board",
      ticket: "/api/agent/ticket?key={key}",
      run: "/api/agent/run?session={sessionId}",
      wait: "/api/agent/wait?session={sessionId}&for={stop|finished}&timeout={seconds, at most 600}",
      transcript: "/api/transcript?session={sessionId}",
      pr: "/api/pr?ref={owner}/{repo}/{number} (needs the X-Agent-Dash header)",
      ticketDetail: "/api/ticket?key={key} (the tracker's description, comments and transitions)",
      history: "/api/history",
    },
    actions: [action(o, "start_conversation", "Start a headless agent with no ticket. Talk to it with /api/reply.", "/api/conversations", { body: { message: "<first message>", cwd: "~" } })],
    ui: ui(o, ""),
  };
}

// ---- board ----------------------------------------------------------------------------

function boardItem(d: Dashboard, s: Subject, o: Origin) {
  const a = lead(s);
  const step = firstStep(d, s);
  const next = a ? needStep(a, step, s.id) : null;
  const t = s.ticket?.ticket;
  const live = liveRuns(s);
  const others = [...new Set(s.items.filter((x) => x !== a).map((x) => x.status))];
  const prName = (url: string) => url.replace(/^https:\/\/github\.com\//, "").replace("/pull/", "#");
  return {
    ref: s.id,
    title: subjectTitle(s, prName),
    ...(t && { ticket: { key: t.key, status: t.status, priority: t.priority, due: t.dueDate, mine: t.assignedToMe } }),
    ...(a && { signal: { kind: a.finished ? "finished" : a.waitsOnReview ? "waits_on_review" : a.kind, reason: a.reason, status: a.status, since: a.since } }),
    ...(others.length && { otherSignals: others }),
    needs: cut(o, needLine(s, d), CUT_LIST),
    ...(next && { next: { label: next.label, ui: ui(o, next.ref) } }),
    ...(step && { firstStep: cut(o, step.label ?? step.body, CUT_LIST) }),
    ...(live.length && { agents: { waiting: live.filter((r) => r.status === "awaiting_input").length, working: live.filter((r) => r.status === "working").length } }),
    ui: ui(o, s.id),
    self: t ? `/api/agent/ticket?key=${q(t.key)}` : s.run ? `/api/agent/run?session=${q(s.run.sessionId)}` : null,
  };
}

/** How many entries a section lists before it only counts. Up next and Starred are never cut. */
const SECTION_LIMIT = 15;
/** Parked asks are many and old: the newest groups, and the newest asks in each, are enough to pick from. `full=1` lists all. */
const ASK_GROUP_LIMIT = 8;

export function agentBoard(d: Dashboard, sections: BoardSections, o: Origin) {
  const section = (id: string, title: string, list: Subject[], hint: string, limit = SECTION_LIMIT) => ({
    id,
    title,
    hint,
    count: list.length,
    items: list.slice(0, o.full ? list.length : limit).map((s) => boardItem(d, s, o)),
  });
  const starred = new Set(sections.starred);
  const unstarred = (l: Subject[]) => l.filter((s) => !starred.has(s));
  return {
    schema: AGENT_SCHEMA,
    generatedAt: d.generatedAt,
    needsYou: sections.needsYou,
    sections: [
      section("starred", "Starred", sections.starred, "Pinned by the person. They lead the queue.", Infinity),
      section("up_next", "Up next", unstarred(sections.queue), "Ranked by urgency: each one needs the person. This is what to work on next.", Infinity),
      {
        id: "parked_asks",
        title: "Parked asks",
        hint: "Agents that agent-dash stopped while they still asked something. Fill {sessionId} in an action to answer or drop one.",
        count: sections.asks.entries,
        items: sections.asks.groups.slice(0, o.full ? undefined : ASK_GROUP_LIMIT).map((g) => ({
          ticket: g.key,
          ui: ui(o, g.key ? `asks:${g.key}` : "asks:none"),
          ...(g.key && { self: `/api/agent/ticket?key=${q(g.key)}` }),
          count: g.rows.length,
          asks: g.rows.slice(0, o.full ? undefined : ASK_GROUP_LIMIT).map((p) => ({ sessionId: p.sessionId, name: p.name, reason: p.reason, parkedAt: p.parkedAt, needs: cut(o, p.needs ?? p.lastMessage, CUT_LIST) })),
        })),
        actions: parkedActions(o, "{sessionId}"),
      },
      section("waiting_on_others", "Waiting on others", unstarred(sections.othersTurn), "Someone else has the next move, such as a reviewer."),
      section("working", "Agents at work", unstarred(sections.working), "An agent works on it, and nothing needs the person."),
      section("finished", "Agents finished", unstarred(sections.finished), "Agents that stopped and need nothing."),
      section("until_change", "Snoozed until something changes", unstarred(sections.untilChange), "Needs the person, but they hid it until a signal changes."),
      section("done_tickets", "Done tickets", unstarred(sections.doneTickets), "Done in the tracker, but agents are still open on them."),
      section("snoozed", "Snoozed", sections.snoozed, "Hidden until a time. A new signal does not bring one back."),
      section("quiet", "Quiet tickets", unstarred(sections.quiet), "The person's tickets with nothing going on."),
    ],
    links: { root: "/api/agent", ticket: "/api/agent/ticket?key={key}" },
  };
}

function parkedAsk(p: ParkedRun, o: Origin) {
  return {
    sessionId: p.sessionId,
    name: p.name,
    reason: p.reason,
    parkedAt: p.parkedAt,
    needs: cut(o, p.needs ?? p.lastMessage),
    latest: cut(o, p.latest),
    actions: parkedActions(o, q(p.sessionId)),
  };
}

function parkedActions(o: Origin, session: string): AgentAction[] {
  return [
    action(o, "send", "Resume the agent headless, with this reply as its first message", `/api/conversations/resume?session=${session}`, { body: { message: "<reply>" } }),
    action(o, "dismiss", "Drop the ask. The conversation stays in History.", `/api/parked/dismiss?session=${session}`),
  ];
}

// ---- runs -----------------------------------------------------------------------------

/** One agent conversation. `ticket` is set when it shows on that ticket, for the resolve and unlink actions. */
export function agentRun(d: Dashboard, r: Run, o: Origin, ticket: string | null, opts: { message?: boolean } = {}) {
  const s = readySummary(d.conversationSummaries[r.sessionId]);
  const id = q(r.sessionId);
  const actions: AgentAction[] = [];
  if (r.status !== "finished" && r.canReply) {
    actions.push(action(o, "reply", r.status === "working" ? "Queue a message for after its turn" : "Reply to the agent", `/api/reply?session=${id}`, { body: { text: "<message>" } }));
    if (r.status === "working" && r.canSteer) actions.push(action(o, "steer", "Interrupt its turn with a message", `/api/reply?session=${id}`, { body: { text: "<message>", steer: true } }));
    if (r.status === "working" && r.canControl) actions.push(action(o, "stop", "Stop its turn", `/api/stop?session=${id}`));
  }
  // Only a headless run: a terminal pi is closed from its own tab. It can be resumed later.
  if (r.status === "awaiting_input" && r.headless) actions.push(action(o, "end", "End it: it needs nothing more. It stays in History, and resume continues it", `/api/conversations/end?session=${id}`));
  if (r.status === "finished") actions.push(action(o, "resume", "Continue it headless, with an optional first message", `/api/conversations/resume?session=${id}`, { body: { message: "<message, or leave out>" } }));
  if (ticket) {
    actions.push(action(o, "resolve", `It no longer matters to ${ticket}`, `/api/threads?ticket=${q(ticket)}&session=${id}`, { body: { status: "resolved" } }));
    actions.push(action(o, "unlink", `It has nothing to do with ${ticket}`, `/api/threads?ticket=${q(ticket)}&session=${id}`, { body: { status: "unlinked" } }));
  }
  actions.push(action(o, "wait", "Block until it stops (status is not working), at most 600 s", `/api/agent/wait?session=${id}&for=stop&timeout=600`, { method: "GET" }));
  return {
    sessionId: r.sessionId,
    title: r.name ?? r.title ?? cut(o, r.firstPrompt),
    agent: r.agent,
    status: r.status,
    since: r.statusSince,
    headless: r.headless,
    askedQuestion: r.askedQuestion,
    endedInError: r.endedInError,
    tickets: r.tickets,
    createdPrs: r.createdPrs,
    cwd: r.cwd,
    ...(r.activity && { activity: r.activity }),
    ...(r.dialog && { dialog: r.dialog }),
    about: cut(o, s?.about),
    latest: cut(o, s?.latest ?? r.lastReply),
    needs: cut(o, s?.needs),
    ...(opts.message && { lastMessage: r.lastMessage || null }),
    ui: ui(o, `c:${r.sessionId}`),
    links: { self: `/api/agent/run?session=${id}`, transcript: `/api/transcript?session=${id}` },
    actions,
  };
}

// ---- ticket ---------------------------------------------------------------------------

function agentPr(d: Dashboard, p: PullRequest, o: Origin) {
  const ref = prRef(p.url);
  const draft = d.reviewDrafts[p.url];
  const sent = d.reviewRequests[p.url]?.[0];
  const actions: AgentAction[] = [];
  if (p.state === "open" && draft?.text && !sent) {
    actions.push(action(o, "request_review", "Post the drafted review request to the team's Slack channel, as the person", "/api/review-requests", { body: { prUrl: p.url, text: draft.text }, effect: "slack", askFirst: true }));
  }
  return {
    url: p.url,
    title: p.title,
    state: p.state,
    draft: p.isDraft,
    checks: p.checks,
    ...(p.failedChecks?.length && { failedChecks: p.failedChecks }),
    review: p.reviewDecision,
    mergeable: p.mergeable,
    toAddress: p.toAddress ?? 0,
    approvals: p.approvals ?? 0,
    ...(sent && { reviewRequested: { at: sent.startedAt, slack: sent.messageUrl } }),
    updatedAt: p.updatedAt,
    ...(ref && { ui: ui(o, ref), detail: `/api/pr?ref=${ref.slice(3)}` }),
    actions,
  };
}

function smoketest(e: SdlcEvent, o: Origin) {
  const actions: AgentAction[] = [];
  // A note goes to the agent that runs the plan, after the run message: for example the limits that it must keep.
  const body = { plannedAt: e.plannedAt, cwd: "~", note: "<what the agent that runs it must also know, or leave out>" };
  // Move things along may confirm and run only a plan whose every environment the settings allow.
  const autoRun = e.environments.length > 0 && e.environments.every(autoRunAllowed);
  if (isPlanWaiting(e)) {
    actions.push(action(o, "confirm_and_run", "Approve the plan's state changes, then run it. Only the person confirms a plan, unless they allowed it for this environment.", `/api/sdlc-events/run?id=${e.id}`, { body, askFirst: true }));
  } else if (e.eventType === "smoketest_plan" && e.plannedAt && e.confirmedAt) {
    actions.push(action(o, "run_again", "Run the accepted plan again (409 while a run is still going)", `/api/sdlc-events/run?id=${e.id}`, { body, askFirst: !autoRun }));
  }
  return {
    id: e.id,
    type: e.eventType,
    environments: e.environments,
    autoRun,
    outcome: e.outcome,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
    summary: cut(o, e.summary),
    ...(e.writesSummary && { writes: cut(o, e.writesSummary) }),
    ...(e.confirmedAt && { confirmedAt: e.confirmedAt, confirmedBy: e.confirmedBy }),
    ...(e.planId && { planId: e.planId }),
    sessionId: e.sessionId,
    actions,
  };
}

export function agentTicket(d: Dashboard, sections: BoardSections, s: Subject, o: Origin) {
  const g = s.ticket!;
  const t = g.ticket;
  const key = q(t.key);
  const events = d.sdlcEvents[t.key] ?? [];
  const progress = sdlcProgress({ ticket: t, prs: g.prs, events });
  const where =
    (
      [
        ["starred", sections.starred],
        ["up_next", sections.queue],
        ["waiting_on_others", sections.othersTurn],
        ["working", sections.working],
        ["finished", sections.finished],
        ["until_change", sections.untilChange],
        ["done_tickets", sections.doneTickets],
        ["snoozed", sections.snoozed],
        ["quiet", sections.quiet],
      ] as const
    ).find(([, l]) => l.includes(s))?.[0] ?? null;
  const runs = relevantRuns(s);
  const live = new Set(liveRuns(s));
  // The live agents, then the newest stopped ones: an older run is in History.
  const shown = [...live, ...runs.filter((r) => !live.has(r)).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, 3)];
  const state = d.summaries[t.key];
  const summary = state?.latest.status === "done" ? state.latest : state?.lastDone;
  const notes = d.notes[t.key] ?? [];
  const snoozed = d.snoozedUntil[t.key] ?? null;
  const starred = (d.starred ?? []).includes(t.key);
  const actions: AgentAction[] = [
    action(o, "start_agent", "Start a headless agent with the ticket's context and this first message", `/api/agents?ticket=${key}`, { body: { message: "<first message>", cwd: "~" } }),
    action(o, "add_note", "Add a private note. Next-steps drafts trust notes over older sources.", `/api/notes?ticket=${key}`, { body: { body: "<note>" } }),
    action(o, "draft_next_steps", "Draft the next steps again (a paid model run, about a minute)", `/api/summaries?ticket=${key}&force=1`),
    action(o, "snooze", "Hide the ticket until a time (ISO 8601), or bring it back with null", `/api/snooze?ticket=${key}`, { body: { until: "<ISO time>" } }),
    action(o, "snooze_until_change", "Hide the entry until one of its signals changes", "/api/until-change", { body: { id: s.id, fingerprint: s.fingerprint } }),
    action(o, starred ? "unstar" : "star", starred ? "Remove the star" : "Pin the ticket to the top of the queue", `/api/star?ticket=${key}`, { body: { starred: !starred } }),
  ];
  const envs = environments().map((e) => e.id);
  if (envs.length) actions.push(action(o, "plan_smoketest", `Start an agent that plans a smoketest. env is one of: ${envs.join(", ")}`, `/api/agents?ticket=${key}`, { body: { sdlc: { kind: "smoketest_plan", env: "<env>" }, cwd: "~" } }));
  if (t.source.move) actions.push(action(o, "move", `Move the ticket in ${t.source.label}. GET /api/ticket?key= lists the statuses it can reach.`, `/api/ticket/move?key=${key}`, { body: { to: "<status>", from: t.status }, effect: t.source.id === "jira" ? "tracker" : "local" }));
  if (t.source.dueDate) {
    // Setting a first due date is routine; replacing one that a person set is their call.
    actions.push(action(o, "set_due", t.dueDate ? `Change the due date from ${t.dueDate}` : "Set a due date", `/api/ticket/due?key=${key}`, { body: { date: "<YYYY-MM-DD>", from: t.dueDate }, effect: t.source.id === "jira" ? "tracker" : "local", askFirst: !!t.dueDate }));
  }
  return {
    schema: AGENT_SCHEMA,
    generatedAt: d.generatedAt,
    ref: s.id,
    ticket: { key: t.key, title: t.summary, status: t.status, statusCategory: t.statusCategory, priority: t.priority, due: t.dueDate, mine: t.assignedToMe, tracker: t.source.label, url: t.url, ...(t.file && { file: t.file }) },
    section: where,
    starred,
    snoozedUntil: snoozed,
    needs: cut(o, needLine(s, d)),
    signals: s.items.map((a) => ({ kind: a.finished ? "finished" : a.waitsOnReview ? "waits_on_review" : a.kind, needsPerson: !a.info, reason: a.reason, status: a.status, since: a.since, ...(a.sessionId && { sessionId: a.sessionId }), ...(a.prUrl && { prUrl: a.prUrl }) })),
    sdlc: { stage: progress.stages[progress.current].id, next: progress.next ? { id: progress.next.id, detail: progress.next.detail } : null },
    nextSteps: summary
      ? {
          generatedAt: summary.generatedAt,
          outOfDate: notes.some((n) => summary.generatedAt && n.createdAt > summary.generatedAt),
          inProgress: state?.latest.status === "in_progress",
          summary: cut(o, summary.summary),
          steps: summary.steps.map((st) => ({
            id: st.id,
            position: st.position,
            body: cut(o, st.body),
            button: st.label,
            actions: [
              st.action?.kind === "move"
                ? action(o, "move", `Move the ticket to ${st.action.to}`, `/api/ticket/move?key=${key}`, { body: { to: st.action.to, from: t.status }, effect: t.source.id === "jira" ? "tracker" : "local" })
                : action(o, "start_step", "Start an agent on this step", `/api/agents?ticket=${key}`, { body: { step: st.id, cwd: "~" } }),
            ],
          })),
        }
      : null,
    agents: shown.map((r) => agentRun(d, r, o, t.key)),
    olderAgents: runs.length - shown.length,
    parkedAsks: d.parked.filter((p) => p.ticket === t.key && sections.parkedNeeds.includes(p)).map((p) => parkedAsk(p, o)),
    prs: g.prs.map((p) => agentPr(d, p, o)),
    smoketests: events.filter((e) => e.eventType !== "review_request").slice(0, 6).map((e) => smoketest(e, o)),
    notes: notes.slice(-5).map((n) => ({ at: n.createdAt, body: cut(o, n.body) })),
    ui: ui(o, s.id),
    links: { detail: `/api/ticket?key=${key}`, context: `/api/agents/context?ticket=${key} (needs the X-Agent-Dash header)`, board: "/api/agent/board" },
    actions,
  };
}

// ---- the "Move things along" button ----------------------------------------------------

/** The conversation name of a run that the button starts. */
export const SKILL_RUN_NAME = "Move things along (agent-dash skill)";

export const MOVE_ALONG_ASK = `Use agent-dash to move my work along.

First, close the agents that wait for me on something that I already did. Read every waiting agent and every parked ask on the board (Up next, parked asks, until-change, snoozed and done tickets). For each one, find out if its ask was done after the agent asked it. Use read-only sources: Slack search (for example, I sent the message that it drafted, or the approval that it waits for came), the PR state (merged or closed), the Jira status, the ticket's notes, and git. If you find proof, close it: use \`resolve\` for an agent on a ticket, \`dismiss\` for a parked ask, and \`end\` for a headless run with no ticket. If the proof is not clear, or part of the ask is still open, leave it open. Never close an agent that is working.

Then go through Starred, then Up next, most urgent first. For each entry, do the next step that you can do yourself inside the limits below, or start an agent on it:

- Reply to a waiting agent (or send a parked ask its answer) when you can answer from the ticket, its notes, the wiki or the code. If it asks for my decision, leave it for me.
- Start an agent on a drafted next step, or on red CI, a merge conflict or review feedback on my own PR. Use the ticket's start_agent action with your own message (the step, plus the limits), not start_step, because a stored step message does not carry the limits.
- Start an agent that plans a smoketest when the ticket's next SDLC stage is a smoketest plan.
- Run smoketests where agent-dash allows it: use a plan's confirm_and_run or run_again action when the plan has autoRun true, and put the hard limits in its note. Never run, or confirm, a plan with autoRun false: leave it for me.
- Add a note to the ticket when you learn something that the next draft needs.

Do not start a second agent on an entry that already has an agent at work. Start at most 5 agents in this run. Do not wait more than 10 minutes in total for agents that you started: leave them running.

When you are done, give me a numbered list: the agents that you closed (each with its ui link and the proof, for example a Slack message link or a merged PR), what you did on each entry (with its ui link), the agents that you started (with their links), and what still needs me, and why.`;

/**
 * Hard limits for the button's agent, and for every agent that it starts or replies to. They hold
 * whatever the ask says, because the agent works with no person watching each step.
 */
export const SKILL_LIMITS = `Hard limits. They hold for you, and for every agent that you start or reply to: put them in each message that you send to an agent.

- Do not post to Slack, and do not send anything else that other people read (for example a comment or review on someone else's PR).
- Do not write to AWS: no create, update, delete or put, in any account.
- Do not create or change Vault secrets.
- Do not write to Jira: no comments, field edits, links, status moves or due dates.
- Do not change prod: no prod deploys, Argo syncs or rollbacks, and no writes to prod systems or data.
- In agent-dash, use only actions with effect "local" and askFirst false. One exception: confirm_and_run and run_again on a smoketest plan with autoRun true. Put these limits in its note. If that plan needs a write that these limits forbid (AWS, Vault, Slack, Jira), do not run it.

Branches, commits, pushes to feature branches, draft or open PRs, notes and local ticket files are fine. When a step needs something past these limits, stop on that entry, and tell me what it needs.`;

/**
 * The first message of the button's agent. It names the skill file by its path, so it works for
 * pi, Claude Code and OpenCode, also where the skill is not installed.
 */
export function skillMessage(skillFile: string, base: string, ask = MOVE_ALONG_ASK): string {
  return `Read the agent-dash skill at \`${skillFile}\`, and follow it. This agent-dash runs at ${base}.\n\n${ask.trim() || MOVE_ALONG_ASK}\n\n${SKILL_LIMITS}`;
}
