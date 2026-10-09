import { needsNothing, waitsOnReview } from "../../shared/conversationSummary.ts";
import type { Dashboard, ParkedRun } from "../../shared/types.ts";

/**
 * A parked agent that could still need you: its ticket is open, and it parked with an ask of its
 * own (it waited too long, or over the cap). The others need nothing: their ticket is Done, the
 * thread is resolved, a newer agent took over, or the summary says "Nothing".
 */
export function parkedNeedsYou(p: ParkedRun, ticketDone: boolean): boolean {
  // No summary was ready, so the row keeps the last message: it can hold a question.
  const asksNothing = p.needs !== null && (needsNothing(p.needs) || waitsOnReview(p.needs));
  return !ticketDone && (p.reason === "stale" || p.reason === "over_cap") && !asksNothing;
}

/** The parked rows split by `parkedNeedsYou`, in their order. */
export function splitParked(data: Pick<Dashboard, "parked" | "myTickets" | "otherTickets">): { needsYou: ParkedRun[]; rest: ParkedRun[] } {
  const done = new Set([...data.myTickets, ...data.otherTickets].filter((g) => g.ticket.statusCategory === "done").map((g) => g.ticket.key));
  const needsYou: ParkedRun[] = [];
  const rest: ParkedRun[] = [];
  for (const p of data.parked) (parkedNeedsYou(p, !!p.ticket && done.has(p.ticket)) ? needsYou : rest).push(p);
  return { needsYou, rest };
}

/** One ticket's parked asks in the board's Parked asks section, or the asks with no ticket. */
export interface AskGroup {
  key: string | null;
  rows: ParkedRun[];
}

export interface ParkedAsks {
  /** Asks on a ticket with an Up next entry, by ticket key: they show in that ticket's "why" list. */
  inQueue: Map<string, ParkedRun[]>;
  /** The board's Parked asks section: tickets newest park first, then the asks with no ticket. */
  groups: AskGroup[];
  /** What the section adds to Needs you: one per ticket, and one per ask with no ticket, which is its own conversation. */
  entries: number;
}

/**
 * Where each parked ask that could need you shows on the board, so that a ticket counts one time.
 * A snoozed ticket's asks wait with it, as its other signals do.
 */
export function parkedAsks(asks: ParkedRun[], queueTickets: Set<string>, snoozedTickets: Set<string>): ParkedAsks {
  const inQueue = new Map<string, ParkedRun[]>();
  const byTicket = new Map<string, ParkedRun[]>();
  const loose: ParkedRun[] = [];
  for (const p of asks) {
    if (!p.ticket) loose.push(p);
    else if (snoozedTickets.has(p.ticket)) continue;
    else {
      const into = queueTickets.has(p.ticket) ? inQueue : byTicket;
      into.set(p.ticket, [...(into.get(p.ticket) ?? []), p]);
    }
  }
  const newest = (rows: ParkedRun[]) => rows.reduce((m, p) => (p.parkedAt > m ? p.parkedAt : m), "");
  const groups: AskGroup[] = [...byTicket].map(([key, rows]) => ({ key, rows })).sort((a, b) => newest(b.rows).localeCompare(newest(a.rows)));
  if (loose.length) groups.push({ key: null, rows: loose });
  return { inQueue, groups, entries: byTicket.size + loose.length };
}

/** The one count of work in the top bar and the tab title: the Up next entries plus the Parked asks entries. */
export function needsYouCount(queue: number, asks: Pick<ParkedAsks, "entries">): number {
  return queue + asks.entries;
}

/** The board ref of a Parked asks group: `asks:KEY`, or `asks:none` for the asks with no ticket. */
export function askRef(key: string | null): string {
  return `asks:${key ?? "none"}`;
}

/** The ticket key of an `asks:` ref (null for no ticket), or undefined when the ref is not one. */
export function askKey(ref: string | null): string | null | undefined {
  if (!ref?.startsWith("asks:")) return undefined;
  const key = ref.slice(5);
  return key === "none" ? null : key;
}
