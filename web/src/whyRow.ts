import { prRef } from "../../shared/refs.ts";
import type { ActionKind, AttentionItem, ConversationSummary } from "../../shared/types.ts";

/**
 * What a signal row says about its object: a type chip, a short name, and where the name links.
 * Kept free of React so the tests can import it.
 */

export type RowType = "Agent" | "PR" | "Smoketest" | "Due date" | "Ticket" | "Next step";

export function rowType(kind: ActionKind): RowType {
  switch (kind) {
    case "awaiting_input":
    case "run_error":
      return "Agent";
    case "overdue":
    case "due_soon":
      return "Due date";
    case "stalled":
      return "Ticket";
    case "next_step":
      return "Next step";
    default:
      return "PR";
  }
}

/** At most `max` characters, cut after a whole word, with "…" when something was cut. */
export function cutWords(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max + 1);
  const space = head.lastIndexOf(" ");
  // One very long word has no boundary to cut at, so it is cut where it is.
  const cut = space > max / 2 ? head.slice(0, space) : t.slice(0, max);
  return `${cut.replace(/[\s,;:.·—–-]+$/, "")}…`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The name without the ticket it is on: a leading "KEY: " goes, and so does the key in the
 * text, with the "of" or "for" in front of it. The page already says which ticket it is.
 */
export function withoutKey(text: string, key: string | null | undefined): string {
  let t = text.replace(/^\s*[A-Z][A-Z0-9]+-\d+\s*[:—–-]\s*/, "");
  if (key) t = t.replace(new RegExp(`(?:\\s+(?:of|for|on|in|to))?\\s*\\b${escape(key)}\\b`, "g"), "");
  return t.replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

/** The agent's short name: the summary's `about` when it has one, else its session name. */
function agentName(item: Pick<AttentionItem, "name">, summary: ConversationSummary | undefined, pageTicket: string | null | undefined, max: number): string {
  const about = summary?.about?.trim();
  return cutWords(withoutKey(about || item.name, pageTicket), max) || cutWords(item.name, max);
}

export interface RowName {
  text: string;
  /** The full name, for the tooltip. */
  full: string;
  /** An agent-dash ref ("r:SESSION", "pr:o/r/7", "t:KEY"), or null when the name is not a link. */
  ref: string | null;
}

/**
 * The short name of the row's object. On a ticket's page, `pageTicket` is that ticket, so a
 * name does not repeat it, and a date row names no ticket at all.
 */
export function rowName(item: Pick<AttentionItem, "kind" | "name" | "title" | "sessionId" | "prUrl" | "ticketKey">, summary: ConversationSummary | undefined, pageTicket: string | null | undefined, max = 60): RowName | null {
  const type = rowType(item.kind);
  if (type === "Agent") {
    return { text: agentName(item, summary, pageTicket, max), full: summary?.about ? `${summary.about}\n${item.name}` : item.name, ref: item.sessionId ? `r:${item.sessionId}` : null };
  }
  if (type === "PR") {
    const title = item.title ? withoutKey(item.title, pageTicket) : "";
    const full = title ? `${item.name} ${item.title}` : item.name;
    // The repo#n part never gets cut: it is the PR's address.
    const text = title ? `${item.name} ${cutWords(title, Math.max(20, max - item.name.length - 1))}` : item.name;
    return { text, full, ref: item.prUrl ? prRef(item.prUrl) : null };
  }
  if (!item.ticketKey || item.ticketKey === pageTicket) return null;
  return { text: item.ticketKey, full: item.ticketKey, ref: `t:${item.ticketKey}` };
}
