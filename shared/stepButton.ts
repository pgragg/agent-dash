/**
 * The kanban card's button for the ticket's top next step: the cheap model's prompt and how its
 * answer is cleaned. Kept free of Node and React, so the server, the page and the tests share one copy.
 */

import type { StepAction } from "./types.ts";

const MAX_LABEL = 60;

/** Bump it when the prompt or the action changes, so each top step gets a label in the new style. */
export const LABEL_VERSION = 3;

/** The label until the model's label comes, or when it gives nothing usable. */
export const FALLBACK_LABEL = "Agent starts the next step";

/** A move needs no model: its label says exactly what the click does. */
export const moveLabel = (to: string): string => `Move ticket to ${to}`;

/** What a click does, in full: the button's hover text. */
export function describeAction(key: string, action: StepAction, cwd: string): string {
  if (action.kind === "move") return `A click moves ${key} to "${action.to}" in its tracker.`;
  return `A click starts an agent in ${cwd}, with ${key}'s context and this first message:\n\n${action.message}`;
}

/**
 * The prompt for the cheap model. It gets the request that the button sends and the agent's exact
 * first message, so the label says what the click does; it does not choose the step.
 */
export function stepLabelPrompt(key: string, stepId: number, message: string): string {
  return `A kanban card for ticket ${key} has one button. A click on it sends \`POST /api/agents?ticket=${key}\` with \`{"step": ${stepId}}\`. The server then starts a coding agent with the ticket's context and the first message below. Write the button's label: what that agent will do, so that the click holds no surprise.

Rules: 3 to 7 words, plain text, sentence case, start with "Agent", no ticket key, no link, no quotes, no end period. Say only what the message asks the agent to do. The message's first paragraph is the same on every button; name the work in the step after it, never a generic label such as "Agent does the next step". When the message names a step for a person (Piper, a reviewer, a teammate), the agent cannot do it for them: say how the agent helps, for example it checks the state, drafts a message, or prepares the command.

Examples of good labels:
- Agent starts work on the ticket
- Agent opens prod parcel bump PR
- Agent re-runs the Beta smoketest
- Agent checks PR for an approval
- Agent drafts the reviewer nudge
- Agent prepares the AWS login command

The agent's first message:
${message.slice(0, 2_500)}

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
