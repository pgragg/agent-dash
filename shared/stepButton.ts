/**
 * The kanban card's button for the ticket's top next step: the cheap model's prompt and how its
 * answer is cleaned. Kept free of Node and React, so the server, the page and the tests share one copy.
 */

const MAX_LABEL = 60;

/** The label until the model's label comes, or when it gives nothing usable. */
export const FALLBACK_LABEL = "Start next step";

/** The prompt for the cheap model. It names the step; it does not choose it. */
export function stepLabelPrompt(key: string, step: string): string {
  return `A kanban card for ticket ${key} has one button. A click starts the ticket's top next step, below. Write the button's label.

Rules: 2 to 5 words, plain text, sentence case, start with a verb, no ticket key, no link, no quotes, no end period. Name what the step does, not who does it.

Examples of good labels:
- Start ticket
- Open prod parcel bump PR
- Move to In Review
- Run Beta smoketest
- Get the PR approved
- Refresh AWS beta login

The step:
${step.slice(0, 2_000)}

Reply with the label only: one line, nothing before or after it.`;
}

/**
 * The model's reply as one short label, with no list mark, quotes, link or end period. Null when
 * nothing is left. The cheap model can write a lead-in line ("Based on the step, the label is:"),
 * so the first line of at most 6 words that does not end in a colon counts.
 */
export function cleanLabel(raw: string): string | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !l.endsWith(":") && l.split(/\s+/).length <= 6) ?? lines[0] ?? "";
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
