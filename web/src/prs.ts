import type { AttentionItem, Dashboard, PullRequest, Ticket } from "../../shared/types.ts";

/** Open PRs grouped by ticket, for the PRs view. Kept free of React so the tests can import it. */

export interface PrEntry {
  pr: PullRequest;
  /** The PR's signals from the queue, most urgent first. Empty when nothing is wrong. */
  items: AttentionItem[];
}

export interface PrGroup {
  /** Null for the PRs that name no ticket. */
  ticket: Ticket | null;
  prs: PrEntry[];
}

const topScore = (e: PrEntry) => e.items[0]?.score ?? 0;
const groupScore = (g: PrGroup) => Math.max(0, ...g.prs.map(topScore));
const newest = (g: PrGroup) => g.prs.map((e) => e.pr.updatedAt).sort().at(-1) ?? "";

/**
 * A PR that names two tickets shows under both, as on the board. Groups with the most urgent
 * PR come first, so the page reads in the same order as the queue; PRs with no ticket come last.
 */
export function groupOpenPrs(d: Pick<Dashboard, "prs" | "attention" | "myTickets" | "otherTickets">): PrGroup[] {
  const tickets = new Map([...d.myTickets, ...d.otherTickets].map((g) => [g.ticket.key, g.ticket]));
  const groups = new Map<string, PrGroup>();
  const none: PrGroup = { ticket: null, prs: [] };
  for (const pr of d.prs) {
    if (pr.state !== "open") continue;
    const entry = { pr, items: d.attention.filter((a) => a.prUrl === pr.url) };
    const keys = pr.tickets.filter((k) => tickets.has(k));
    if (!keys.length) none.prs.push(entry);
    for (const key of keys) {
      const ticket = tickets.get(key)!;
      if (!groups.has(key)) groups.set(key, { ticket, prs: [] });
      groups.get(key)!.prs.push(entry);
    }
  }
  const all = [...groups.values(), none].filter((g) => g.prs.length);
  for (const g of all) g.prs.sort((a, b) => topScore(b) - topScore(a) || b.pr.updatedAt.localeCompare(a.pr.updatedAt));
  return all.sort((a, b) => Number(!a.ticket) - Number(!b.ticket) || groupScore(b) - groupScore(a) || newest(b).localeCompare(newest(a)));
}

/** How many distinct open PRs, when a PR can show under more than one ticket. */
export function countPrs(groups: PrGroup[]): number {
  return new Set(groups.flatMap((g) => g.prs.map((e) => e.pr.url))).size;
}
