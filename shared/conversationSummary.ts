/**
 * The short summary on each agent conversation: what it is about, what the agent said last, and
 * what it needs from Piper. A cheap model writes it; this file holds its prompt and the parser,
 * free of Node and React, so the server, the page and the tests share one copy.
 */
import type { RunStatus } from "./types.ts";
import { User, user } from "./team.ts";

export interface ConversationGist {
  about: string;
  latest: string;
  needs: string;
}

/** A function, not a constant: the user's name comes from the settings after this module loads. */
const statusText = (status: RunStatus): string =>
  ({ working: "The agent is working now.", awaiting_input: `The agent stopped and waits for ${user()}.`, finished: "The conversation ended." })[status];

/** The prompt for the cheap model. `digest` is the chat without tool traffic, newest kept. */
export function gistPrompt(status: RunStatus, digest: string): string {
  return `Summarise this conversation between ${user()} (USER) and a coding agent (AGENT) for a card on ${user()}'s dashboard. ${statusText(status)}

Write exactly three lines, in this format, with plain text and no markdown:
ABOUT: <what the conversation is about, at most 15 words>
LATEST: <what the agent's latest message says, at most 35 words>
NEEDS: <what the agent needs from ${user()} now (an answer, a decision, an approval, a review), at most 25 words; or "Nothing">

When the only thing left is that another person reviews or approves a PR (${user()} only has to get it approved), and the agent asks nothing else, write NEEDS: Waiting on review: <the PR>.

Use short sentences and simple words. Name the ticket, PR or system when the conversation names it. Do not invent facts.

<conversation>
${digest}
</conversation>`;
}

/** The three lines of the model's reply. Null when one is missing. */
export function parseGist(raw: string): ConversationGist | null {
  const field = (name: string) =>
    raw
      .match(new RegExp(`^\\W*${name}\\W*:\\s*(.+)$`, "im"))?.[1]
      .replace(/^["'`*_]+|["'`*_]+$/g, "")
      .trim() ?? "";
  const about = field("ABOUT");
  const latest = field("LATEST");
  const needs = field("NEEDS");
  return about && latest && needs ? { about, latest, needs } : null;
}

/** Changes the basis of every summary, so a new prompt drafts the current ones again. */
export const GIST_VERSION = 2;

/** The prompt's marker for a stop where the next move is a reviewer's, not Piper's. */
export function waitsOnReview(needs: string | null): boolean {
  return !!needs && /^waiting on (a |the )?(pr )?(review|approval)\b/i.test(needs.trim());
}

/** "Nothing", "None", "Nothing now." and the like: the agent needs no input. */
export function needsNothing(needs: string | null): boolean {
  return !needs || /^(nothing|none|no input|n\/a)\b/i.test(needs.trim());
}
