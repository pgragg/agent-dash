/**
 * Jira changes that the dash makes itself, with Piper's click as the approval: a due date
 * (`/api/ticket/due`) and a status move (`/api/ticket/move`). Neither needs an agent.
 */

export function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Two weeks from today, the skill's default when no date is named. A local day, as Jira's due date is. */
export function defaultDueDate(now: Date): string {
  return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14));
}

/** One field on a transition screen, from `transitions?expand=transitions.fields`. */
export interface ScreenField {
  key: string;
  type: string;
}

/**
 * The `fields` of a transition request. FSDK screens reject a transition with an empty field,
 * even when Jira calls the field optional, so echo each value the issue holds and fill an empty
 * date: the due date two weeks out, any other date with today. Same rule as jira-ticket.sh.
 */
export function screenFields(screen: ScreenField[], issue: Record<string, unknown>, now: Date): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of screen) {
    const cur = issue[f.key];
    if (cur != null) out[f.key] = typeof cur === "object" && !Array.isArray(cur) && (cur as { id?: unknown }).id != null ? { id: (cur as { id: unknown }).id } : cur;
    else if (f.type === "date") out[f.key] = f.key === "duedate" ? defaultDueDate(now) : localDay(now);
  }
  return out;
}

/** A status the ticket can reach: in one transition, or in two through `via`. */
export interface MoveTarget {
  to: string;
  via: string | null;
}

/**
 * The statuses a move can reach from `current`. FSDK's Backlog cannot reach In Progress in one
 * transition, but its "Prioritized" lands in To Do, which can, so offer that walk too.
 */
export function moveTargets(transitions: { to: string }[], current: string): MoveTarget[] {
  const out: MoveTarget[] = transitions.filter((t) => t.to !== current).map((t) => ({ to: t.to, via: null }));
  if (current !== "In Progress" && !out.some((t) => t.to === "In Progress") && out.some((t) => t.to === "To Do")) out.push({ to: "In Progress", via: "To Do" });
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The transition that a drafted step asks for, such as "Piper moves the ticket to In Review",
 * so the step gets a Move button instead of an agent. Only a status the ticket can reach now.
 */
export function moveStepTarget(body: string, key: string, targets: MoveTarget[]): MoveTarget | null {
  // Longest first, so "In Review" wins over "Review".
  for (const t of [...targets].sort((a, b) => b.to.length - a.to.length)) {
    const re = new RegExp(`\\bmov(?:e|es|ing)\\s+((?:[^.!?\\n]|[.!?](?=\\S)){0,200}?)\\s+to\\s+[*_"\`]*${escape(t.to)}\\b`, "i");
    const object = body.match(re)?.[1];
    // A sentence ends at ". ", not at the dots of a link. The object must be "the ticket", "it",
    // or this ticket's key or link, so "move the due date to …" does not count.
    if (object !== undefined && new RegExp(`\\b(ticket|it|${escape(key)})\\b`, "i").test(object)) return t;
  }
  return null;
}
