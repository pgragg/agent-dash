import { prRef } from "../../shared/refs.ts";
import type { AttentionItem, NextStep } from "../../shared/types.ts";

/** The next move for a "needs you" item, as a place in agent-dash: never Jira or GitHub. */
export interface NeedStep {
  label: string;
  /** An agent-dash ref, such as "r:SESSION", "pr:o/r/7", "step:5" or "t:KEY". */
  ref: string;
}

/**
 * Where to act on the item that put an entry in the queue. A PR signal opens the PR panel, an
 * agent signal opens the agent card, and a ticket signal opens the drafted step, else the ticket.
 */
export function needStep(item: AttentionItem, firstStep: NextStep | null, fallback: string): NeedStep {
  const pr = item.prUrl ? prRef(item.prUrl) : null;
  const ticket = item.ticketKey ? `t:${item.ticketKey}` : fallback;
  switch (item.kind) {
    case "awaiting_input":
      return item.sessionId ? { label: "Reply to the agent", ref: `r:${item.sessionId}` } : { label: "Open on the board", ref: ticket };
    case "run_error":
      return item.sessionId ? { label: "Open the agent", ref: `r:${item.sessionId}` } : { label: "Open on the board", ref: ticket };
    case "changes_requested":
    case "ci_failing":
    case "merge_conflict":
    case "ready_to_merge":
    case "in_review":
      return pr ? { label: "Open the PR", ref: pr } : { label: "Open on the board", ref: ticket };
    case "overdue":
    case "due_soon":
      return { label: "Set a new due date", ref: ticket };
    case "stalled":
      return firstStep ? { label: "Open the next step", ref: `step:${firstStep.id}` } : { label: "Draft next steps", ref: ticket };
  }
}
