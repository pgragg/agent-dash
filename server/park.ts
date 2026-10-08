import { readdirSync } from "node:fs";
import { join } from "node:path";
import { needsNothing, waitsOnReview } from "../shared/conversationSummary.ts";
import type { ConversationSummary, ParkReason, ParkedRun, Run, ThreadStatusChange } from "../shared/types.ts";
import { config } from "./config.ts";
import { resolvedAway } from "./model.ts";
import { isAlive, type ReportedStatus } from "./sources/status.ts";
import * as db from "./summaries/db.ts";

/**
 * Park: stop a waiting headless agent and keep what it needed. Piper cannot follow 100 waiting
 * agents, and each one holds a pi process. The session log stays, so Resume continues the run.
 */

/** The most agents that may wait for Piper at once. */
export const PARK_CAP = 15;
/** A new stop gets this long first, so its notification goes out and Piper can read it live. */
export const GRACE_MS = 30 * 60_000;
/** An agent this idle is more likely forgotten than blocking. */
export const STALE_MS = 24 * 60 * 60_000;
/** A run that Piper resumed after a park is left alone this long. */
export const RESUMED_EXEMPT_MS = 24 * 60 * 60_000;

export interface ParkInput {
  /** Every run on the board, once each. */
  runs: Run[];
  summaries: Record<string, ConversationSummary>;
  /** Ticket keys whose Jira status category is Done. */
  done: Set<string>;
  threads: ThreadStatusChange[];
  /** Runs the sweep must not park, such as one that Piper resumed after a park. */
  exempt: Set<string>;
  /** Tickets with an entry in the queue: there, a resolved agent's ask is already shown. */
  shown?: Set<string>;
  /** Agents of parallel lanes: they work side by side, so a newer lane does not replace an older one. */
  laneSessions?: Set<string>;
  now: number;
  cap?: number;
}

export interface ParkChoice {
  run: Run;
  reason: ParkReason;
  summary: ConversationSummary | undefined;
}

/** The summary is drafted for the run as it is now, so it can say what the agent needs. */
function summaryReady(s: ConversationSummary | undefined): boolean {
  return !!s && s.status !== "in_progress" && !(s.status === "done" && s.stale);
}

/**
 * Which waiting agents to park, and why. A run that the dash cannot restart exactly (a terminal
 * tab, an open dialog, a guessed status) is never parked, but it counts towards the cap.
 */
export function choosePark(input: ParkInput): ParkChoice[] {
  const { runs, summaries, done, now } = input;
  const cap = input.cap ?? PARK_CAP;
  const resolved = new Set(input.threads.filter((t) => t.status === "resolved").map((t) => `${t.ticket} ${t.sessionId}`));
  const waiting = runs.filter((r) => r.status === "awaiting_input");
  const waited = (r: Run) => now - Date.parse(r.statusSince);
  const parkable = (r: Run) => r.statusSource === "extension" && r.headless && !r.dialog && !input.exempt.has(r.sessionId) && waited(r) >= GRACE_MS && summaryReady(summaries[r.sessionId]);

  const chosen = new Map<string, ParkChoice>();
  const park = (r: Run, reason: ParkReason) => chosen.set(r.sessionId, { run: r, reason, summary: summaries[r.sessionId] });
  const candidates = waiting.filter(parkable);

  for (const r of candidates) {
    const isResolved = (k: string) => resolved.has(`${k} ${r.sessionId}`);
    const s = summaries[r.sessionId];
    const nothing = s?.status === "done" && (needsNothing(s.needs) || waitsOnReview(s.needs));
    if (r.tickets.length && r.tickets.every((k) => done.has(k))) park(r, "ticket_done");
    else if (r.tickets.length && r.tickets.every((k) => done.has(k) || isResolved(k)) && (nothing || resolvedAway(r, (k) => done.has(k) || isResolved(k), input.shown ?? new Set()))) park(r, "resolved");
    else if (nothing) park(r, "needs_nothing");
  }
  // A newer live agent on the same ticket carries the work on; the older one's ask goes to the Parked list.
  const live = runs.filter((r) => r.status !== "finished" && !chosen.has(r.sessionId));
  for (const r of candidates) {
    if (chosen.has(r.sessionId)) continue;
    if (r.tickets[0] && !input.laneSessions?.has(r.sessionId) && live.some((o) => o.sessionId !== r.sessionId && o.tickets[0] === r.tickets[0] && o.startedAt > r.startedAt)) park(r, "superseded");
    else if (waited(r) > STALE_MS && !r.askedQuestion) park(r, "stale");
  }

  // Over the cap, the agents that asked a question stay first, then the newest stops.
  const left = waiting.filter((r) => !chosen.has(r.sessionId));
  let over = left.length - cap;
  const order = left.filter(parkable).sort((a, b) => Number(a.askedQuestion) - Number(b.askedQuestion) || a.statusSince.localeCompare(b.statusSince));
  for (const r of order) {
    if (over <= 0) break;
    park(r, "over_cap");
    over--;
  }
  return [...chosen.values()];
}

/** A reply that the extension has not read yet means the run is about to work again. */
function inboxHasMail(sessionId: string): boolean {
  try {
    return readdirSync(join(config.inboxDir, sessionId)).some((f) => /\.(txt|steer|abort)$/.test(f));
  } catch {
    return false;
  }
}

/** The status file still says the run waits, since the same time, in a process that is alive. */
export function stillWaiting(run: Run, s: ReportedStatus | undefined, alive: (pid: number) => boolean = isAlive): s is ReportedStatus {
  return !!s && s.mode === "rpc" && s.state === "awaiting_input" && !s.dialog && s.since === run.statusSince && alive(s.pid);
}

export function parkedRow(c: ParkChoice, now: Date): ParkedRun {
  const done = c.summary?.status === "done" || c.summary?.status === "failed";
  return {
    sessionId: c.run.sessionId,
    ticket: c.run.tickets[0] ?? null,
    name: c.run.name ?? c.run.firstPrompt.slice(0, 80),
    cwd: c.run.cwd,
    reason: c.reason,
    parkedAt: now.toISOString(),
    needs: done ? (c.summary?.needs ?? null) : null,
    latest: done ? (c.summary?.latest ?? null) : null,
    lastMessage: c.run.lastMessage.slice(-4_000),
  };
}

/**
 * Close the parks of runs that are live again, then park what `choosePark` picks. Returns the
 * number of changes. Each park writes its row before the signal, so a crash never loses the ask.
 */
export function sweep(input: Omit<ParkInput, "exempt">, reported: Map<string, ReportedStatus>, now = new Date()): number {
  let changes = 0;
  const byId = new Map(input.runs.map((r) => [r.sessionId, r]));
  for (const p of db.activeParked()) {
    const r = byId.get(p.sessionId);
    // The parked process can take a moment to exit; only a status written after the park is a resume.
    if (r && r.status !== "finished" && r.statusSince > p.parkedAt && db.endParked(p.sessionId, "resumed", now)) changes++;
  }
  const exempt = new Set([...db.resumedSince(new Date(now.getTime() - RESUMED_EXEMPT_MS).toISOString())]);
  for (const c of choosePark({ ...input, exempt })) {
    const s = reported.get(c.run.sessionId);
    if (!stillWaiting(c.run, s) || inboxHasMail(c.run.sessionId)) continue;
    db.addParked(parkedRow(c, now));
    try {
      process.kill(s.pid, "SIGTERM");
      changes++;
    } catch {
      // The process exited on its own: the row still keeps the ask.
    }
  }
  return changes;
}
