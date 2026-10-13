import { needsNothing } from "./conversationSummary.ts";
import { agentFinished, agentWaitsOnReview, asksNothing, readySummary, runsOf, summaryText } from "./notify.ts";
import { type ParkedAsks, needsYouCount, parkedAsks, splitParked } from "./parkedRows.ts";
import { runTitle } from "./runTitle.ts";
import { smoketestRow } from "./smoketestRow.ts";
import { isSnoozed } from "./snooze.ts";
import { starredFirst } from "./star.ts";
import { age } from "./time.ts";
import type { AttentionItem, Dashboard, NextStep, ParkedRun, Run, TicketGroup } from "./types.ts";

/**
 * The board's entries and sections. The page and the agent view (`/api/agent/*`) both build the
 * board from here, so an agent sees the same queue, in the same order, as Piper does.
 */

/** One board entry: a ticket, else a run with no ticket, else a PR with no ticket and no run. */
export interface Subject {
  id: string;
  ticket: TicketGroup | null;
  /** A run with no ticket. */
  run: Run | null;
  /** A PR with no ticket and no run. */
  prUrl: string | null;
  /** Most urgent first. */
  items: Item[];
  /** Changes whenever a signal changes, so "snooze until something changes" expires on news. */
  fingerprint: string;
}

/** A signal, with the summary of its agent's conversation when it has one. */
export interface Item extends AttentionItem {
  /** The summary for the notification. Null until it is ready, so nothing old shows. */
  gist: string | null;
  /** The agent stopped, and its summary says it needs nothing from you. */
  finished: boolean;
  /** The agent stopped, and its only ask is that a reviewer approves its PR. */
  waitsOnReview: boolean;
}

export function buildSubjects(d: Dashboard): Map<string, Subject> {
  const out = new Map<string, Subject>();
  const add = (id: string, init: Omit<Subject, "id" | "items" | "fingerprint">) => {
    if (!out.has(id)) out.set(id, { id, items: [], fingerprint: "", ...init });
    return out.get(id)!;
  };
  for (const g of [...d.myTickets, ...d.otherTickets]) add(`t:${g.ticket.key}`, { ticket: g, run: null, prUrl: null });
  for (const r of d.unlinkedRuns) add(`r:${r.sessionId}`, { ticket: null, run: r, prUrl: null });
  const runs = new Map(runsOf(d).map((r) => [r.sessionId, r]));
  for (const a of d.attention) {
    const id = a.ticketKey ? `t:${a.ticketKey}` : a.sessionId ? `r:${a.sessionId}` : `p:${a.prUrl}`;
    const s = out.get(id) ?? add(id, { ticket: null, run: a.run ?? null, prUrl: a.prUrl ?? null });
    const agent = a.kind === "awaiting_input" || a.kind === "run_error";
    const summary = agent && a.sessionId ? d.conversationSummaries[a.sessionId] : undefined;
    const run = runs.get(a.sessionId ?? "");
    const finished = a.kind === "awaiting_input" && agentFinished(run, summary);
    // The reviewer has the next move, so the stop waits on others, as a PR out for review does.
    const review = a.kind === "awaiting_input" && agentWaitsOnReview(run, summary);
    const name = run && `“${runTitle(run).slice(0, 60)}”`;
    // The server's reason says "is waiting for you", which a finished agent is not.
    const reason = review && name ? `${name} waits on a PR review` : finished && name ? `${name} finished ${age(run.statusSince, Date.parse(d.generatedAt))} ago` : a.reason;
    const status = review ? "waits on review" : finished ? "finished" : a.status;
    // A finished agent needs nothing, so it is not on your queue, unless its smoketest still needs you (a plan to Confirm, a failed run).
    const idle = finished && !smoketestRow(a.sessionId, a.ticketKey ? (d.sdlcEvents[a.ticketKey] ?? []) : [], { asked: false, finished: true })?.needsYou;
    // A stalled ticket whose newest agent asks nothing of you is quiet, not a task.
    const settled = a.kind === "stalled" && asksNothing(d.conversationSummaries[a.sessionId ?? ""]);
    s.items.push({ ...a, info: a.info || review || idle || settled, reason, status, gist: summaryText(summary), finished, waitsOnReview: review });
  }
  for (const s of out.values()) s.fingerprint = s.items.map((a) => `${a.kind}${a.finished ? ":finished" : ""}${a.waitsOnReview ? ":review" : ""}@${a.updatedAt}`).join("|");
  return out;
}

/** The ticket is Done in its tracker. */
export function isDone(s: Subject): boolean {
  return s.ticket?.ticket.statusCategory === "done";
}

/** Something here needs you, not only someone else. */
export function actionable(s: Subject): boolean {
  return s.items.some((a) => !a.info);
}

/** Only agents that finished and need nothing: not your move, and not someone else's either. */
export function onlyFinished(s: Subject): boolean {
  return s.items.length > 0 && s.items.every((a) => a.finished && a.info);
}

/** The item that leads: the most urgent one that needs you, else the first. */
export function lead(s: Subject): Item | undefined {
  return s.items.find((a) => !a.info) ?? s.items[0];
}

export function subjectTitle(s: Subject, prName: (url: string) => string = (u) => u): string {
  if (s.ticket) return s.ticket.ticket.summary;
  if (s.run) return runTitle(s.run);
  return s.prUrl ? prName(s.prUrl) : s.id;
}

/** You marked this thread as no longer relevant to the subject's ticket. */
export function isResolved(s: Subject, run: Run): boolean {
  return s.ticket?.threads[run.sessionId]?.status === "resolved";
}

/** The ticket's threads that still matter: everything you have not marked resolved. */
export function relevantRuns(s: Subject): Run[] {
  return s.ticket ? s.ticket.runs.filter((r) => !isResolved(s, r)) : s.run ? [s.run] : [];
}

/** Live agents first (waiting before working), then the newest. */
export function liveRuns(s: Subject): Run[] {
  const runs = relevantRuns(s);
  const rank = (r: Run) => (r.status === "awaiting_input" ? 0 : r.status === "working" ? 1 : 2);
  return runs.filter((r) => r.status !== "finished").sort((a, b) => rank(a) - rank(b) || b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/** The run that "open in iTerm" and the reply box act on. */
export function primaryRun(s: Subject): Run | undefined {
  return s.items.find((a) => a.run?.status === "awaiting_input")?.run ?? liveRuns(s)[0] ?? s.items.find((a) => a.run)?.run;
}

/** The first drafted next step of the entry's ticket, from the newest finished summary. */
export function firstStep(data: Dashboard, s: Subject): NextStep | null {
  const state = s.ticket ? data.summaries[s.ticket.ticket.key] : undefined;
  const shown = state?.latest.status === "done" ? state.latest : state?.lastDone;
  return shown?.steps[0] ?? null;
}

/** What the lead agent needs from you, from its summary: the "Needs from you" line of a queue entry. */
export function needLine(s: Subject, data: Dashboard): string | null {
  const a = lead(s);
  if (!a || a.info || !a.sessionId || (a.kind !== "awaiting_input" && a.kind !== "run_error")) return null;
  const ready = readySummary(data.conversationSummaries[a.sessionId]);
  return ready && !needsNothing(ready.needs) ? ready.needs : null;
}

/** The rail's sections, each in its page order. A subject shows in one section only. */
export interface BoardSections {
  starred: Subject[];
  /** Up next, starred entries first: what the top bar's Needs you counts. */
  queue: Subject[];
  /** Entries that need you, but that you snoozed until something changes. */
  untilChange: Subject[];
  othersTurn: Subject[];
  finished: Subject[];
  working: Subject[];
  doneTickets: Subject[];
  quiet: Subject[];
  /** Tickets snoozed to a time, soonest back first. */
  snoozed: Subject[];
  /** The parked asks that could need you, and where each one shows. */
  parkedNeeds: ParkedRun[];
  asks: ParkedAsks;
  /** The top bar's one count of work. */
  needsYou: number;
  /** Every unsnoozed entry in rail order, then the snoozed ones: what J and K walk. */
  order: Subject[];
}

/** Sorts the board's subjects into its sections. `marked` says if an entry is snoozed until something changes. */
export function boardSections(data: Dashboard, subjects: Map<string, Subject>, now: number, marked: (s: Subject) => boolean): BoardSections {
  const until = (s: Subject) => (s.ticket ? data.snoozedUntil[s.ticket.ticket.key] : undefined);
  const ticketSnoozed = (s: Subject) => isSnoozed(until(s), now);
  // A snoozed ticket leaves every other section until its time comes, whatever its signals say.
  const snoozed = [...subjects.values()].filter(ticketSnoozed).sort((a, b) => until(a)!.localeCompare(until(b)!));
  const all = [...subjects.values()].filter((s) => !ticketSnoozed(s));
  const starredKeys = new Set(data.starred ?? []);
  const isStarred = (s: Subject) => !!s.ticket && starredKeys.has(s.ticket.ticket.key);
  const byScore = (a: Subject, b: Subject) => lead(b)!.score - lead(a)!.score;
  const ranked = all.filter(actionable).sort(byScore);
  // Starred entries lead the queue, so their ranks are the first ones.
  const queue = starredFirst(ranked.filter((s) => !marked(s)), isStarred);
  const untilChange = ranked.filter(marked);
  // Only context left, such as a PR out for review: the ball is with someone else.
  const othersTurn = all.filter((s) => s.items.length && !actionable(s) && !isDone(s) && !onlyFinished(s)).sort(byScore);
  const finished = all.filter((s) => !actionable(s) && !isDone(s) && onlyFinished(s)).sort(byScore);
  const working = all.filter((s) => !s.items.length && liveRuns(s).length && !isDone(s));
  // Closed in its tracker, but agents still open on it: worth a glance to close the tabs, never a task.
  const doneTickets = all.filter((s) => isDone(s) && (s.items.length || liveRuns(s).length));
  const quiet = data.myTickets.map((g) => subjects.get(`t:${g.ticket.key}`)!).filter((s) => !ticketSnoozed(s) && !s.items.length && !liveRuns(s).length);
  // A starred ticket shows once, in the Starred section at the top of the rail; a snooze still hides it.
  const unsnoozed = [...queue, ...othersTurn, ...working, ...finished, ...untilChange, ...doneTickets, ...quiet];
  const starred = unsnoozed.filter(isStarred);
  const unstarred = (list: Subject[]) => list.filter((s) => !isStarred(s));
  // The rail's Snoozed section shows the entries snoozed until something changes, then the ones snoozed to a time.
  const order = [...starred, ...unstarred(unsnoozed.filter((s) => !untilChange.includes(s))), ...unstarred(untilChange), ...snoozed];
  // The parked asks that could need you: each one shows in its ticket's "why" list when the ticket is in Up next, else under Parked asks.
  const parkedNeeds = splitParked(data).needsYou;
  const queueTickets = new Set(queue.flatMap((s) => (s.ticket ? [s.ticket.ticket.key] : [])));
  const snoozedTickets = new Set(Object.entries(data.snoozedUntil ?? {}).flatMap(([k, u]) => (isSnoozed(u, now) ? [k] : [])));
  const asks = parkedAsks(parkedNeeds, queueTickets, snoozedTickets);
  return { starred, queue, untilChange, othersTurn, finished, working, doneTickets, quiet, snoozed, parkedNeeds, asks, needsYou: needsYouCount(queue.length, asks), order };
}
