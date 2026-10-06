import { needsNothing } from "../../shared/conversationSummary.ts";
import type { ConversationSummary, Dashboard, Run, RunStatus } from "../../shared/types.ts";

/**
 * Which runs to announce with a browser notification. Kept free of React so the tests can import it.
 *
 * A run is announced when the page sees it go from working to waiting for you. Short runs
 * do not count: when a reply comes that fast, you are most likely still at that tab. A reply
 * you stopped with Esc does not count either, because then you are at the tab already.
 */

export const MIN_RUN_MS = 45_000;

export interface Seen {
  status: RunStatus;
  since: string;
}

/** Every run on the dashboard once. A run that names two tickets shows under both. */
export function runsOf(d: Pick<Dashboard, "myTickets" | "otherTickets" | "unlinkedRuns">): Run[] {
  const out = new Map<string, Run>();
  for (const g of [...d.myTickets, ...d.otherTickets]) for (const r of g.runs) out.set(r.sessionId, r);
  for (const r of d.unlinkedRuns) out.set(r.sessionId, r);
  return [...out.values()];
}

export function snapshot(runs: Run[]): Map<string, Seen> {
  return new Map(runs.map((r) => [r.sessionId, { status: r.status, since: r.statusSince }]));
}

/** With no earlier snapshot (the page just loaded), nothing is new, so nothing is announced. */
export function newlyWaiting(prev: Map<string, Seen> | null, runs: Run[], minRunMs = MIN_RUN_MS): Run[] {
  if (!prev) return [];
  return runs.filter((r) => {
    const before = prev.get(r.sessionId);
    // Only the extension knows when a run started working; a status guessed from the log would announce stale runs.
    if (before?.status !== "working" || r.status !== "awaiting_input" || r.statusSource !== "extension") return false;
    if (r.stoppedByUser) return false;
    return Date.parse(r.statusSince) - Date.parse(before.since) >= minRunMs;
  });
}

/** Where a click on the notification goes: the board entry that holds the run. */
export function boardHash(r: Run): string {
  return `#/${encodeURIComponent(r.tickets[0] ? `t:${r.tickets[0]}` : `r:${r.sessionId}`)}`;
}

// ---- summaries ----------------------------------------------------------------------

/** Only a summary of the run's current state counts; an older one describes another stop. */
export function readySummary(s: ConversationSummary | undefined): (ConversationSummary & { latest: string }) | null {
  return s && s.status === "done" && !s.stale && s.latest ? (s as ConversationSummary & { latest: string }) : null;
}

/** Without a ready summary we do not guess: the run counts as waiting. */
export function agentFinished(run: Run | undefined, s: ConversationSummary | undefined): boolean {
  const ready = readySummary(s);
  return !!run && !!ready && run.status === "awaiting_input" && !run.dialog && !run.askedQuestion && needsNothing(ready.needs);
}

/** The need goes on its own line, so a notification shows it apart. */
export function summaryText(s: ConversationSummary | undefined): string | null {
  const ready = readySummary(s);
  if (!ready) return null;
  return needsNothing(ready.needs) ? ready.latest : `${ready.latest}\nNeeds from you: ${ready.needs}`;
}

/** The model answers in seconds; past this, a broken summary must not hide the notification. */
export const SUMMARY_WAIT_MS = 2 * 60_000;

/** A notification held until its run's summary is ready. */
export interface Pending {
  /** The run's `statusSince` when it started to wait: a new wait is a new notification. */
  since: string;
  heldAt: number;
}

/** A run that moved on drops its notification: that stop no longer needs you. */
export function releasePending(pending: Map<string, Pending>, runs: Run[], summaries: Record<string, ConversationSummary>, now: number, waitMs = SUMMARY_WAIT_MS): { send: Run[]; keep: Map<string, Pending> } {
  const byId = new Map(runs.map((r) => [r.sessionId, r]));
  const send: Run[] = [];
  const keep = new Map<string, Pending>();
  for (const [id, p] of pending) {
    const r = byId.get(id);
    if (!r || r.status !== "awaiting_input" || r.statusSince !== p.since) continue;
    const s = summaries[id];
    // A run with no message never gets a summary, so it does not wait.
    if (!r.lastMessage || readySummary(s) || (s?.status === "failed" && !s.stale) || now - p.heldAt >= waitMs) send.push(r);
    else keep.set(id, p);
  }
  return { send, keep };
}

/** Without a ready summary, the last reply is the best text we have. */
export function notificationFor(r: Run, s: ConversationSummary | undefined): { title: string; body: string } {
  const name = r.name ?? r.firstPrompt;
  const head = `${agentFinished(r, s) ? "Agent finished" : "Agent is waiting on you"}: ${name}`;
  return { title: head.length > 90 ? `${head.slice(0, 89)}…` : head, body: summaryText(s) ?? (r.lastReply || "Waiting for you") };
}
