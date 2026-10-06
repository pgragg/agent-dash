import { useState } from "react";
import { sdlcProgress, STAGE_LABELS, type StageId } from "../../shared/sdlc.ts";
import type { SdlcEvent, TicketGroup } from "../../shared/types.ts";

/** The Board shows the queue with a workspace, or a kanban board with one column per SDLC stage. */
export type BoardMode = "queue" | "kanban";

const MODE_KEY = "agent-dash:board-mode";

export function useBoardMode(): [BoardMode, (m: BoardMode) => void] {
  const [mode, setMode] = useState<BoardMode>(() => (localStorage.getItem(MODE_KEY) === "kanban" ? "kanban" : "queue"));
  return [
    mode,
    (m) => {
      setMode(m);
      localStorage.setItem(MODE_KEY, m);
    },
  ];
}

/** The furthest stage that the ticket reached. The board holds only my recent PRs, so it can lag behind the workspace's progress bar. */
export function stageOf(group: TicketGroup, events: SdlcEvent[]): StageId {
  const p = sdlcProgress({ ticket: group.ticket, prs: group.prs, events });
  return p.stages[p.current].id;
}

export interface KanbanColumn<T> {
  id: StageId | "none";
  label: string;
  items: T[];
}

/** One column per SDLC stage, then one for entries with no ticket. Each column keeps the order of `items`. */
export function kanbanColumns<T>(items: T[], column: (item: T) => StageId | null): KanbanColumn<T>[] {
  const cols: KanbanColumn<T>[] = [...Object.entries(STAGE_LABELS).map(([id, label]) => ({ id: id as StageId, label, items: [] as T[] })), { id: "none", label: "No ticket", items: [] }];
  const byId = new Map(cols.map((c) => [c.id, c]));
  for (const item of items) byId.get(column(item) ?? "none")!.items.push(item);
  return cols;
}

/** What a card search reads: the ticket keys of the card, and its other text. */
export interface Searchable {
  keys: string[];
  text: string[];
}

// A key match must beat any number of text matches, so a key search finds its card first.
const KEY_EXACT = 1000;
const KEY_NUMBER = 800;
const KEY_PREFIX = 400;
const KEY_PART = 200;
const TEXT = 1;

/** The score of one card, or null when a word of the query matches nothing on it. Case-insensitive. */
export function searchScore(card: Searchable, query: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const keys = card.keys.map((k) => k.toLowerCase());
  const text = card.text.join("\n").toLowerCase();
  let score = 0;
  for (const w of words) {
    let best = 0;
    for (const k of keys) {
      const s = k === w ? KEY_EXACT : k.split("-").at(-1) === w ? KEY_NUMBER : k.startsWith(w) ? KEY_PREFIX : k.includes(w) ? KEY_PART : 0;
      best = Math.max(best, s);
    }
    if (!best && text.includes(w)) best = TEXT;
    if (!best) return null;
    score += best;
  }
  return score;
}

/** The cards that match every word, best score first. Equal scores keep the order of `items`. An empty query keeps all. */
export function searchCards<T>(items: T[], query: string, fields: (item: T) => Searchable): T[] {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, score: searchScore(fields(item), query) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}
