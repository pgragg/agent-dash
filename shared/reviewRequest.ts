/**
 * Slack review requests for PRs: the channel, the message format, and the cheap model's prompt.
 * Kept free of Node and React, so the server, the page and the tests share one copy.
 */

import { team } from "./team.ts";

export interface ReviewChannel {
  id: string;
  name: string;
  /** A Slack user group that the post tags, such as the team's engineers. */
  group?: { id: string; handle: string };
}

/** The team's review channel from the settings, or null when review requests are off. */
export const reviewChannel = (): ReviewChannel | null => (team.reviewChannelId ? { id: team.reviewChannelId, name: team.reviewChannelName || team.reviewChannelId } : null);

/** One `reviewRoutes` entry: `DOCS:docs-review=C0123456789:docs-team=S0123456789`. The group part is optional. */
export const REVIEW_ROUTE = /^([A-Z][A-Z0-9]*):([a-z0-9_-]+)=([CG][A-Z0-9]{6,})(?::([a-z0-9._-]+)=(S[A-Z0-9]{6,}))?$/;

/**
 * The channel for a PR's review request: the first route whose prefix one of the PR's tickets has,
 * else the review channel. Different teams review in different channels.
 */
export function reviewChannelFor(tickets: string[]): ReviewChannel | null {
  for (const route of team.reviewRoutes) {
    const m = route.match(REVIEW_ROUTE);
    if (!m || !tickets.some((k) => k.startsWith(`${m[1]}-`))) continue;
    return { id: m[3], name: m[2], ...(m[5] ? { group: { id: m[5], handle: m[4] } } : {}) };
  }
  return reviewChannel();
}

/** The text as Slack gets it: a route's group is tagged in front, once. */
export function slackText(channel: ReviewChannel, text: string): string {
  if (!channel.group || text.includes(`<!subteam^${channel.group.id}`)) return text;
  return `<!subteam^${channel.group.id}> ${text}`;
}

/** "#docs-review" or "#docs-review, tags @docs-team", as the page shows the target. */
export const channelLabel = (c: ReviewChannel): string => `#${c.name}${c.group ? `, tags @${c.group.handle}` : ""}`;

/** A repo in noReviewRepos has no reviewer, so a Slack review request has no reader. */
export const wantsReviewRequest = (pr: { repo: string; state: string; tickets: string[] }): boolean => !!reviewChannelFor(pr.tickets) && pr.state === "open" && !team.noReviewRepos.includes(pr.repo);

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
- return the required field from the API to fix the chat bug
- skip migrations on the API, the worker, and the dashboard in prod

The PR:
Repo: ${pr.repo}
Title: ${pr.title}
Changed files: ${pr.files.slice(0, 20).join(", ") || "unknown"}
Description:
${pr.body.slice(0, 3_000) || "(none)"}`;
}
