import { needsNothing, waitsOnReview } from "../../shared/conversationSummary.ts";
import { runTitle } from "../../shared/runTitle.ts";
import type { AttentionItem, AttentionKind, ConversationSummary, Dashboard, HistoryRun, Run, RunStatus } from "../../shared/types.ts";

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

/** The board entry that holds the run: its ticket, else the run itself. */
export function entryOf(r: Run): string {
  return r.tickets[0] ? `t:${r.tickets[0]}` : `r:${r.sessionId}`;
}

/** Where a click on the notification goes: the board entry that holds the run. */
export function boardHash(r: Run): string {
  return `#/${encodeURIComponent(entryOf(r))}`;
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

/** The agent's only ask is that a reviewer approves its PR, so the next move is the reviewer's. */
export function agentWaitsOnReview(run: HistoryRun | undefined, s: ConversationSummary | undefined): boolean {
  const ready = readySummary(s);
  return !!run && !!ready && run.status === "awaiting_input" && !run.dialog && waitsOnReview(ready.needs);
}

export type AgentState = RunStatus | "waits_on_review";

/**
 * How an agent shows in every place: the queue entry, the "why" list, its card, the Notifications
 * row, the tab title and the browser notification. An agent that waits on review is not waiting on you.
 */
export function agentState(run: HistoryRun, s: ConversationSummary | undefined): AgentState {
  return agentWaitsOnReview(run, s) ? "waits_on_review" : run.status;
}

/** The count of waiting agents (`counts.awaiting_input`), without the ones that only wait on a PR review. */
export function waitingOnYou(awaiting: number, runs: HistoryRun[], summaries: Record<string, ConversationSummary>): number {
  const review = new Set(runs.filter((r) => agentState(r, summaries[r.sessionId]) === "waits_on_review").map((r) => r.sessionId));
  return Math.max(0, awaiting - review.size);
}

/** The run's current summary asks nothing of you: it needs nothing, or only a reviewer. */
export function asksNothing(s: ConversationSummary | undefined): boolean {
  const ready = readySummary(s);
  return !!ready && (needsNothing(ready.needs) || waitsOnReview(ready.needs));
}

/** The need goes on its own line, so a notification shows it apart. */
export function summaryText(s: ConversationSummary | undefined): string | null {
  const ready = readySummary(s);
  if (!ready) return null;
  if (waitsOnReview(ready.needs)) return `${ready.latest}\n${ready.needs}`;
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

/** A run that moved on, or that only waits on a PR review, drops its notification: that stop does not need you. */
export function releasePending(pending: Map<string, Pending>, runs: Run[], summaries: Record<string, ConversationSummary>, now: number, waitMs = SUMMARY_WAIT_MS): { send: Run[]; keep: Map<string, Pending> } {
  const byId = new Map(runs.map((r) => [r.sessionId, r]));
  const send: Run[] = [];
  const keep = new Map<string, Pending>();
  for (const [id, p] of pending) {
    const r = byId.get(id);
    if (!r || r.status !== "awaiting_input" || r.statusSince !== p.since) continue;
    const s = summaries[id];
    if (agentWaitsOnReview(r, s)) continue;
    // A run with no message never gets a summary, so it does not wait.
    if (!r.lastMessage || readySummary(s) || (s?.status === "failed" && !s.stale) || now - p.heldAt >= waitMs) send.push(r);
    else keep.set(id, p);
  }
  return { send, keep };
}

// ---- one notification per board entry ------------------------------------------------

/**
 * Notifications are grouped by board entry (a ticket, else the run or PR with no ticket): four
 * tickets with ten updates each make four notifications, not forty. The first update after you
 * last looked at the entry alerts; each later one replaces that notification without a sound.
 */

/** One thing that happened on an entry. */
export interface Update {
  /** What it is about, so a second stop of the same agent replaces its line. */
  key: string;
  title: string;
  line: string;
}

export interface Group {
  label: string;
  /** Every update since you last looked, also repeats of one key. */
  count: number;
  /** Newest first, one per key. */
  updates: Update[];
}

/** `alert` is true for the first update since you last looked: only that one makes a sound. */
export function addUpdate(groups: Map<string, Group>, id: string, label: string, u: Update): { group: Group; alert: boolean } {
  const prev = groups.get(id);
  const group = { label, count: (prev?.count ?? 0) + 1, updates: [u, ...(prev?.updates ?? []).filter((x) => x.key !== u.key)] };
  groups.set(id, group);
  return { group, alert: !prev };
}

/** Lines in the body before "and N more": a notification shows about three. */
export const LINES_SHOWN = 3;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function groupNotification(g: Group): { title: string; body: string } {
  const only = g.count === 1 ? g.updates[0] : null;
  const title = cut(only ? `${g.label}: ${only.title}` : `${g.label}: ${g.count} updates`, 90);
  if (only) return { title, body: only.line };
  const lines = g.updates.slice(0, LINES_SHOWN).map((u) => cut(`${u.title}: ${u.line.replace(/\s+/g, " ")}`, 120));
  const more = g.updates.length - LINES_SHOWN;
  return { title, body: [...lines, ...(more > 0 ? [`and ${more} more`] : [])].join("\n") };
}

/** An agent stop as an update. Without a ready summary, the last reply is the best text we have. */
export function runUpdate(r: Run, s: ConversationSummary | undefined): Update {
  const name = runTitle(r);
  const what = agentFinished(r, s) ? "Agent finished" : "Agent is waiting on you";
  return { key: `agent:${r.sessionId}`, title: what, line: `${cut(name, 60)}\n${summaryText(s) ?? (r.lastReply || "Waiting for you")}` };
}

/**
 * The signals that are not an agent stop and that need you. An agent's own signals come from
 * its stop, which waits for the summary. `stalled` is no news, and a PR out for review waits on
 * the reviewer.
 */
export const NEED_TITLES: Partial<Record<AttentionKind, string>> = {
  changes_requested: "Changes requested",
  ci_failing: "CI is failing",
  merge_conflict: "Merge conflict",
  ready_to_merge: "Ready to merge",
  approved_with_feedback: "Approved, with feedback",
  overdue: "Overdue",
  due_soon: "Due soon",
};

export function needKey(a: Pick<AttentionItem, "kind" | "prUrl" | "ticketKey">): string {
  return `${a.kind}:${a.prUrl ?? a.ticketKey ?? ""}`;
}

/** Each signal that needs you, by key. A Done ticket's signals are `info`, so they never count. */
export function needSignals(attention: AttentionItem[]): Map<string, AttentionItem> {
  return new Map(attention.filter((a) => !a.info && NEED_TITLES[a.kind]).map((a) => [needKey(a), a]));
}

/** With no earlier snapshot (the page just loaded), nothing is new. A signal that went away and came back is new again. */
export function newSignals(prev: Map<string, AttentionItem> | null, now: Map<string, AttentionItem>): AttentionItem[] {
  return prev ? [...now].filter(([k]) => !prev.has(k)).map(([, a]) => a) : [];
}

export function signalUpdate(a: AttentionItem): Update {
  return { key: needKey(a), title: NEED_TITLES[a.kind] ?? a.kind, line: a.reason };
}

/** The entry of a signal, as the board groups it. */
export function entryOfSignal(a: Pick<AttentionItem, "ticketKey" | "sessionId" | "prUrl">): string {
  return a.ticketKey ? `t:${a.ticketKey}` : a.sessionId ? `r:${a.sessionId}` : `p:${a.prUrl}`;
}

// ---- seen ----------------------------------------------------------------------------

/** When you last looked at each board entry, by entry id. Kept in localStorage. */
export type SeenAt = Record<string, string>;

/** Entries you have not looked at for this long drop out, so the record stays small. */
export const SEEN_KEEP_MS = 30 * 24 * 3600_000;

export function pruneSeen(seen: SeenAt, now: number): SeenAt {
  return Object.fromEntries(Object.entries(seen).filter(([, at]) => now - Date.parse(at) < SEEN_KEEP_MS));
}

/** A row is new when it came after your last look. An entry you never looked at is all new. */
export function isNewSince(since: string, lastLook: string | null): boolean {
  return !lastLook || Date.parse(since) > Date.parse(lastLook);
}
