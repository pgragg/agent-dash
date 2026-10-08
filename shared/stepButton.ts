/**
 * The kanban card's button for the ticket's top next step: the cheap model's prompt and how its
 * answer is cleaned. Kept free of Node and React, so the server, the page and the tests share one copy.
 */

const MAX_LABEL = 60;

/** Bump it when the prompt changes, so each top step gets a label in the new style. */
export const LABEL_VERSION = 2;

/** The label until the model's label comes, or when it gives nothing usable. */
export const FALLBACK_LABEL = "Agent starts the next step";

/** The prompt for the cheap model. It says what a click does; it does not choose the step. */
export function stepLabelPrompt(key: string, step: string): string {
  return `A kanban card for ticket ${key} has one button for the ticket's top next step, below. Write the button's label: what a click on it makes happen.

What a click does:
- When the step only moves the ticket to a new status in Jira, the click moves the ticket. The label is "Move ticket to <status>".
- Else the click starts a coding agent, and its task is the step. The label says what that agent does, and starts with "Agent". When the step is for a person (Piper, a reviewer, a teammate), the agent cannot do it for them: say how the agent helps, for example it checks the state, drafts a message, or prepares the command.

Rules: 3 to 7 words, plain text, sentence case, no ticket key, no link, no quotes, no end period.

Examples of good labels:
- Agent starts work on the ticket
- Agent opens prod parcel bump PR
- Agent re-runs the Beta smoketest
- Agent checks PR for an approval
- Agent drafts the reviewer nudge
- Agent prepares the AWS login fix
- Move ticket to In Review

The step:
${step.slice(0, 2_000)}

Reply with the label only: one line, nothing before or after it.`;
}

/**
 * The model's reply as one short label, with no list mark, quotes, link or end period. Null when
 * nothing is left. The cheap model can write a lead-in line ("Based on the step, the label is:"),
 * so the first line of at most 8 words that does not end in a colon counts.
 */
export function cleanLabel(raw: string): string | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !l.endsWith(":") && l.split(/\s+/).length <= 8) ?? lines[0] ?? "";
  const label = line
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/^(?:label|button)\s*:\s*/i, "")
    .replace(/^["'`*_]+|["'`*_]+$/g, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (!label) return null;
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1).trimEnd()}…` : label;
}
