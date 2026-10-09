import type { AttentionItem } from "../../shared/types.ts";

/**
 * The ticket header's two groups: what needs you, and news. Kept free of React so the tests can
 * import it. The queue rail keeps its score order.
 */

export interface WhyEntry {
  item: Pick<AttentionItem, "kind" | "info" | "since">;
  /** The agent stopped, and its summary says it needs nothing from you. */
  finished: boolean;
  /** A smoketest row's own answer (AD-10), which outranks the item's. */
  smoketestNeedsYou?: boolean;
}

/**
 * A PR out for review never needs you here: the ball is with the reviewer, even when it is stale.
 * An `info` item (also every item of a Done ticket) never does either.
 */
export function needsYou(e: WhyEntry): boolean {
  if (e.item.info) return false;
  if (e.smoketestNeedsYou !== undefined) return e.smoketestNeedsYou;
  return !e.item.info && !e.finished && e.item.kind !== "in_review";
}

const time = (iso: string) => Date.parse(iso) || 0;

/** Newest first in each group. The sort is stable, so equal times keep the score order they came in. */
export function groupWhy<T extends WhyEntry>(entries: T[]): { needs: T[]; updates: T[] } {
  const newest = (list: T[]) => [...list].sort((a, b) => time(b.item.since) - time(a.item.since));
  return { needs: newest(entries.filter(needsYou)), updates: newest(entries.filter((e) => !needsYou(e))) };
}

/** Updates shown before "Show N more". */
export const UPDATES_SHOWN = 3;

/** "waiting 13h" as "waiting": the row has its own age column. */
export function statusWord(status: string): string {
  return status.replace(/\s+\d+[smhdw](?=\s*(·|$))/, "").trim() || status;
}
