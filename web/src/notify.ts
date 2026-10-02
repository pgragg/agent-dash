import type { Dashboard, Run, RunStatus } from "../../shared/types.ts";

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
