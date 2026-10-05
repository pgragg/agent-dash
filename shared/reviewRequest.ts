/**
 * Slack review requests for PRs: the channel, the message format, and the cheap model's prompt.
 * Kept free of Node and React, so the server, the page and the tests share one copy.
 */

/** The Fern AWS migration team asks for PR reviews here. */
export const REVIEW_CHANNEL = { id: "C0BFE2ABFA9", name: "proj-fern-aws-migration-devs" };

const MAX_SUMMARY = 160;

/** The format the team already uses: "PR: bind slack token env vars https://github.com/…/pull/13612". */
export function reviewMessage(summary: string, url: string): string {
  return `PR: ${summary} ${url}`;
}

/** A message from the PR title alone, for when the model gives nothing usable. */
export function fallbackMessage(title: string, url: string): string {
  return reviewMessage(cleanSummary(title.replace(/\s*\[?\b[A-Z][A-Z0-9]+-\d+\b\]?/g, "").replace(/^\w+(\([^)]*\))?!?:\s*/, "")) || "please review", url);
}

/**
 * The model's reply as one short phrase: the first line, with no quotes, no "PR:", no link and
 * no end period. Empty when nothing is left.
 */
export function cleanSummary(raw: string): string {
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^["'`*_]+|["'`*_]+$/g, "")
    .replace(/^PR:\s*/i, "")
    .replace(/[.\s]+$/, "")
    .trim()
    .slice(0, MAX_SUMMARY);
}

/** The prompt for the cheap model. It writes only the phrase; the code adds "PR:" and the link. */
export function draftPrompt(pr: { repo: string; title: string; body: string; files: string[] }): string {
  return `Write the middle of a Slack message that asks teammates to review a GitHub PR. The message is "PR: <phrase> <link>"; write only <phrase>.

Rules: one line, at most 12 words, plain text, no link, no ticket key, no quotes, no end period. Say what the change does, in plain words, starting with a lower-case verb.

Examples of good phrases:
- bind slack token env vars
- add the agent Auth0 client and encryption key so automations run
- return required field from FDR to fix fai-chat bug
- skip migrations on FDR, Venus, and Fern Dashboard in prod

The PR:
Repo: ${pr.repo}
Title: ${pr.title}
Changed files: ${pr.files.slice(0, 20).join(", ") || "unknown"}
Description:
${pr.body.slice(0, 3_000) || "(none)"}`;
}
