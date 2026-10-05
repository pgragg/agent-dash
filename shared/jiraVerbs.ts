/**
 * First messages for agents that make one Jira change: a verb button starts an agent with one
 * of these messages, and the click is the approval. A due date needs no agent, so the server
 * sets it itself (`/api/ticket/due`). The first line is short, because it becomes the run's name.
 */
const SKILL = "~/.pi/agent/skills/jira-tickets/SKILL.md";

/** Jira returns these names; strip what could break out of the quotes or the first line. */
function clean(s: string): string {
  return s.replace(/["\r\n`]/g, "").trim();
}

export function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** Move the ticket to a status. A status transition needs no approval. */
export function moveMessage(key: string, status: string, transition?: string): string {
  const to = clean(status);
  const via = transition && clean(transition) !== to ? ` (the Jira transition is called "${clean(transition)}")` : "";
  return `Move ${key} to "${to}" in Jira.

Use the jira-tickets skill (read ${SKILL} first). Move ${key} to the status "${to}"${via}. Piper clicked this in agent-dash, so a status transition needs no further approval: apply it.

Make exactly this one change and nothing else: no comment, no other field, no other ticket. If the ticket has a due date, keep it (\`--no-due\`). If it has none, the transition screen fills one anyway (see the skill's note on \`--no-due\`): pass the skill's default \`--due\`, and say which date it set.

If "${to}" cannot be reached from the current status in one transition, stop and tell Piper which statuses are on the way. When you are done, reply with the old status and the new status.`;
}

/** Two weeks from today, the skill's default when no date is named. A local day, as Jira's due date is. */
export function defaultDueDate(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
