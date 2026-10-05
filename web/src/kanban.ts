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
