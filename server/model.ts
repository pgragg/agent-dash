import type { AttentionItem, Dashboard, HistoryRun, PullRequest, Run, RunStatus, ThreadStatusChange, Ticket, TicketGroup } from "../shared/types.ts";
import { rankAttention } from "./attention.ts";
import { heuristicStatus, type ParsedSession } from "./sources/sessions.ts";
import { resolveReported, type ReportedStatus, takesControls } from "./sources/status.ts";

export interface ModelInput {
  sessions: ParsedSession[];
  reported: Map<string, ReportedStatus>;
  myTickets: Ticket[];
  otherTickets: Ticket[];
  prs: PullRequest[];
  now: number;
  recentDays: number;
  sources: Dashboard["sources"];
  extensionInstalled: boolean;
  summaries?: Dashboard["summaries"];
  notes?: Dashboard["notes"];
  snoozedUntil?: Dashboard["snoozedUntil"];
  starred?: Dashboard["starred"];
  /** Current status of each (ticket, thread) pair that has one. */
  threads?: ThreadStatusChange[];
  isAlive?: (pid: number) => boolean;
  jiraServer: string;
}

export function toRuns(sessions: ParsedSession[], reported: Map<string, ReportedStatus>, now: number, isAlive?: (pid: number) => boolean): Run[] {
  return sessions
    .filter((s) => s.userMessageCount > 0) // A tab that was opened and never used.
    .map((s) => {
      const r = reported.get(s.sessionId);
      const { status, since } = r ? resolveReported(r, isAlive) : heuristicStatus(s, now);
      return {
        sessionId: s.sessionId,
        sessionFile: s.sessionFile,
        cwd: s.cwd,
        name: s.name,
        firstPrompt: s.firstPrompt,
        lastReply: s.lastReply,
        lastMessage: s.lastMessage,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        model: s.model,
        status,
        statusSource: r ? "extension" : "heuristic",
        statusSince: since,
        askedQuestion: s.askedQuestion || Boolean(r?.dialog && status !== "finished"),
        endedInError: !s.midRun && s.lastStopReason === "error",
        stoppedByUser: !s.midRun && s.lastStopReason === "aborted",
        tickets: [...s.tickets],
        createdPrs: s.createdPrs,
        mentionedPrs: s.mentionedPrs,
        userMessageCount: s.userMessageCount,
        itermSessionId: r && status !== "finished" ? (r.itermSessionId ?? null) : null,
        canReply: Boolean(r?.inbox) && status !== "finished",
        headless: r?.mode === "rpc" && status !== "finished",
        activity: status === "working" ? (r?.activity ?? null) : null,
        dialog: status !== "finished" ? (r?.dialog ?? null) : null,
        canControl: takesControls(r) && status !== "finished",
      } satisfies Run;
    });
}

/**
 * A PR title carries the ticket key more reliably than the chat does, so a run that opened
 * a PR inherits its tickets, and a PR with no key inherits the tickets of the run that opened it.
 */
type ThreadMap = Map<string, ThreadStatusChange>;
const threadKey = (ticket: string, sessionId: string) => `${ticket} ${sessionId}`;
const threadMap = (threads: ThreadStatusChange[]): ThreadMap => new Map(threads.map((t) => [threadKey(t.ticket, t.sessionId), t]));

/**
 * Link runs and PRs, then take each run off the tickets that you unlinked it from. The first pass
 * stops a PR with no key from taking an unlinked ticket; the second removes one that a PR named.
 */
function linkRuns(runs: Run[], prs: PullRequest[], threads: ThreadMap): void {
  const unlink = () => {
    for (const r of runs) r.tickets = r.tickets.filter((k) => threads.get(threadKey(k, r.sessionId))?.status !== "unlinked");
  };
  unlink();
  crossLink(runs, prs);
  unlink();
}

export function crossLink(runs: Run[], prs: PullRequest[]): void {
  const byUrl = new Map(prs.map((p) => [p.url, p]));
  for (const run of runs) {
    for (const url of run.createdPrs) {
      const pr = byUrl.get(url);
      if (!pr) continue;
      for (const key of pr.tickets) if (!run.tickets.includes(key)) run.tickets.push(key);
      // Only the run's main ticket: a run that names several tickets opened this PR for one.
      if (pr.tickets.length === 0 && run.tickets[0]) pr.tickets.push(run.tickets[0]);
    }
  }
}

/** Every chat, newest first, for the History view. Unlike the board, it has no time window. */
export function buildHistory(sessions: ParsedSession[], reported: Map<string, ReportedStatus>, prs: PullRequest[], now: number, isAlive?: (pid: number) => boolean, threads: ThreadStatusChange[] = []): HistoryRun[] {
  const runs = toRuns(sessions, reported, now, isAlive);
  linkRuns(runs, prs.map((p) => ({ ...p, tickets: [...p.tickets] })), threadMap(threads));
  return runs.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).map(({ lastMessage: _cut, ...rest }) => rest);
}

export function isRecent(iso: string, now: number, days: number): boolean {
  return now - Date.parse(iso) <= days * 86_400_000;
}

/** Ticket keys worth a Jira lookup: named by a recent run or PR, but not on my open list. */
export function otherTicketKeys(sessions: ParsedSession[], prs: PullRequest[], myKeys: Set<string>, now: number, days: number): string[] {
  const keys = new Set<string>();
  for (const s of sessions) if (s.userMessageCount > 0 && isRecent(s.lastActivityAt, now, days)) s.tickets.forEach((k) => keys.add(k));
  for (const p of prs) if (isRecent(p.updatedAt, now, days)) p.tickets.forEach((k) => keys.add(k));
  return [...keys].filter((k) => !myKeys.has(k)).sort();
}


function group(ticket: Ticket, runs: Run[], prs: PullRequest[], threads: ThreadMap): TicketGroup {
  const mine = runs.filter((r) => r.tickets.includes(ticket.key)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const states: Record<string, ThreadStatusChange> = {};
  for (const r of mine) {
    const t = threads.get(threadKey(ticket.key, r.sessionId));
    if (t) states[r.sessionId] = t;
  }
  return {
    ticket,
    runs: mine,
    prs: prs.filter((p) => p.tickets.includes(ticket.key)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    threads: states,
  };
}

/**
 * The same runs, minus the tickets that you marked them resolved for. Ranking uses these, so a
 * resolved thread no longer puts its ticket in the queue. A thread resolved for all of its
 * tickets still shows as a run of its own while it waits for you.
 */
export function withoutResolved(runs: Run[], threads: ThreadMap, done: Set<string> = new Set()): Run[] {
  return runs.map((r) => {
    const tickets = r.tickets.filter((k) => threads.get(threadKey(k, r.sessionId))?.status !== "resolved");
    // A run counts first for a ticket that is still open, so a Done ticket does not take its signal.
    tickets.sort((a, b) => Number(done.has(a)) - Number(done.has(b)));
    return tickets.join() === r.tickets.join() ? r : { ...r, tickets };
  });
}

function stubTicket(key: string, server: string): Ticket {
  return { key, url: `${server}/browse/${key}`, summary: "(not found in Jira)", status: "?", statusCategory: "new", priority: null, dueDate: null, updatedAt: "", assignedToMe: false };
}

const byRecent = (a: Run, b: Run) => b.lastActivityAt.localeCompare(a.lastActivityAt);

/**
 * Give every row a run to jump to, so each one can open a tab or copy a resume command.
 * A ticket row prefers a live run, because its tab is where the work continues.
 */
export function attachRuns(items: AttentionItem[], runs: Run[]): void {
  const byId = new Map(runs.map((r) => [r.sessionId, r]));
  for (const item of items) {
    let run = item.sessionId ? byId.get(item.sessionId) : undefined;
    if (!run && item.prUrl) run = runs.filter((r) => r.createdPrs.includes(item.prUrl!)).sort(byRecent)[0];
    if (!run && item.ticketKey) {
      const mine = runs.filter((r) => r.tickets.includes(item.ticketKey!)).sort(byRecent);
      run = mine.find((r) => r.status !== "finished") ?? mine[0];
    }
    if (run) {
      item.run = run;
      item.sessionId = run.sessionId;
    }
  }
}

const CATEGORY_ORDER: Record<Ticket["statusCategory"], number> = { indeterminate: 0, new: 1, done: 2 };

export function buildDashboard(input: ModelInput): Dashboard {
  const { now, recentDays } = input;
  const runs = toRuns(input.sessions, input.reported, now, input.isAlive);
  const prs = input.prs.map((p) => ({ ...p, tickets: [...p.tickets] }));
  const threads = threadMap(input.threads ?? []);
  linkRuns(runs, prs, threads);
  const recentRuns = runs.filter((r) => r.status !== "finished" || isRecent(r.lastActivityAt, now, recentDays));
  const done = new Set([...input.myTickets, ...input.otherTickets].filter((t) => t.statusCategory === "done").map((t) => t.key));
  const attention = rankAttention(withoutResolved(recentRuns, threads, done), prs, input.myTickets, now, input.jiraServer);
  // The ticket is closed, so nothing on it is a task any more: an open tab there is only worth knowing about.
  for (const a of attention) if (a.ticketKey && done.has(a.ticketKey)) a.info = true;
  attachRuns(attention, withoutResolved(runs, threads, done));

  // Tickets with the most urgent item come first, so the list reads in the same order as the queue.
  const topScore = new Map<string, number>();
  for (const a of attention) if (a.ticketKey && !topScore.has(a.ticketKey)) topScore.set(a.ticketKey, a.score);
  const lastRunAt = (g: TicketGroup) => g.runs.at(-1)?.lastActivityAt ?? "";

  const myKeys = new Set(input.myTickets.map((t) => t.key));
  const myTickets = input.myTickets
    .map((t) => group(t, runs, prs, threads))
    .sort(
      (a, b) =>
        (topScore.get(b.ticket.key) ?? 0) - (topScore.get(a.ticket.key) ?? 0) ||
        CATEGORY_ORDER[a.ticket.statusCategory] - CATEGORY_ORDER[b.ticket.statusCategory] ||
        lastRunAt(b).localeCompare(lastRunAt(a)),
    );

  const known = new Map(input.otherTickets.map((t) => [t.key, t]));
  const otherKeys = new Set([...recentRuns.flatMap((r) => r.tickets), ...prs.filter((p) => isRecent(p.updatedAt, now, recentDays)).flatMap((p) => p.tickets)]);
  const otherTickets = [...otherKeys]
    .filter((k) => !myKeys.has(k))
    .map((k) => group(known.get(k) ?? stubTicket(k, input.jiraServer), runs, prs, threads))
    .sort((a, b) => lastRunAt(b).localeCompare(lastRunAt(a)));

  const unlinkedRuns = recentRuns.filter((r) => r.tickets.length === 0).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

  const counts: Record<RunStatus, number> = { working: 0, awaiting_input: 0, finished: 0 };
  for (const r of recentRuns) counts[r.status] += 1;

  return {
    generatedAt: new Date(now).toISOString(),
    attention,
    myTickets,
    otherTickets,
    unlinkedRuns,
    prs,
    counts,
    summaries: input.summaries ?? {},
    notes: input.notes ?? {},
    snoozedUntil: input.snoozedUntil ?? {},
    starred: input.starred ?? [],
    // Filled by the server, which keeps each action's row in SQLite.
    actions: [],
    diagrams: [],
    sdlcEvents: {},
    reviewDrafts: {},
    conversationSummaries: {},
    reviewRequests: {},
    lanes: {},
    sources: input.sources,
    extensionInstalled: input.extensionInstalled,
  };
}

