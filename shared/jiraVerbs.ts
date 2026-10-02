/**
 * First messages for agents that make one Jira change. The dash itself never writes to Jira:
 * a verb button starts an agent with one of these messages, and the click is the approval.
 * The first line is short, because it becomes the new run's name.
 */
const SKILL = "~/.pi/agent/skills/jira-tickets/SKILL.md";

/** Jira returns these names; strip what could break out of the quotes or the first line. */
function clean(s: string): string {
  return s.replace(/["\r\n`]/g, "").trim();
}

function isDate(s: string): boolean {
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

/** Set the due date. A first due date needs no approval; changing an existing one does. */
export function dueDateMessage(key: string, date: string, current: string | null): string {
  if (!isDate(date)) throw new Error(`not a date: ${date}`);
  const head = `Set the due date of ${key} to ${date} in Jira.

Use the jira-tickets skill (read ${SKILL} first). Check the current due date with the skill's \`view\` command before you change anything.`;
  const rule = current
    ? `agent-dash shows that ${key} already has the due date ${current}. Changing an existing due date needs Piper's approval: show Piper the plan that the skill prints for the change from ${current} to ${date}, and wait for Piper to say yes before you apply it with \`--yes\`.`
    : `agent-dash shows that ${key} has no due date. A first due date needs no approval: apply it.`;
  return `${head}

${rule} If the current due date is not what agent-dash shows, follow the rule for what you find: no due date means apply it, an existing due date means ask first.

Make exactly this one change and nothing else: no transition, no comment, no other field. When you are done, reply with the old and the new due date.`;
}

/** Two weeks from today, the skill's default when no date is named. */
export function defaultDueDate(now: Date): string {
  return new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
}
