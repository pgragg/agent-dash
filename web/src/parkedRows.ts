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
