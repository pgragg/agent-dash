import type { PrDetail, PrReviewThread } from "./types.ts";

/**
 * Which PR feedback still needs an answer. The PR panel lists it, and the board counts it, so an
 * approval that asks for a change is not "merge it". Free of Node and React, one copy for both.
 */

export type FeedbackState = "to_address" | "replied" | "outdated" | "addressed" | "report";

/**
 * Bot comments that report a status and ask for nothing: Atlantis plan and apply output, and
 * deploy previews. Only conversation comments match; a bot thread on a line of code is a finding.
 */
const STATUS_REPORTS: RegExp[] = [
  /^Ran (Plan|Apply) for (dir: |\d+ projects:)/, // Atlantis
  /^\[vc\]: #/, // Vercel
  /^[^\n]*Deploy Preview for /, // Netlify
];

export const isStatusReport = (c: { bot: boolean; body: string }) => c.bot && STATUS_REPORTS.some((re) => re.test(c.body.trimStart()));

/** One entry of the panel's Feedback section: a review body, a conversation comment, or an unresolved thread. */
export interface FeedbackEntry {
  /** The GitHub URL of the review or comment; for a thread, of its newest comment. */
  key: string;
  kind: "review" | "comment" | "thread";
  author: string;
  bot: boolean;
  /** When it was posted; for a thread, its newest comment. */
  at: string;
  state: FeedbackState;
  /** A review's state word, for example "APPROVED". */
  reviewState?: string;
  body?: string;
  thread?: PrReviewThread;
  /** A commit came after it. That can be a fix with no reply, so it stays to address. */
  commitSince: boolean;
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/**
 * GitHub has no resolved state for a review body or a conversation comment. One counts as
 * replied when the PR author wrote in the conversation after it. A commit does not count,
 * because an approval often asks for one more change, and a push does not say which.
 */
export function feedback(d: FeedbackSource): FeedbackEntry[] {
  const mine = (login: string) => !!d.author && login.toLowerCase() === d.author.toLowerCase();
  const marked = new Set(d.addressed);
  const lastReply = Math.max(0, ...d.comments.filter((c) => mine(c.author)).map((c) => time(c.createdAt)), ...d.reviews.filter((r) => mine(r.author) && r.body.trim()).map((r) => time(r.submittedAt)));
  const commitSince = (at: string) => time(d.lastCommitAt) > time(at);
  const said = (key: string, at: string): FeedbackState => (marked.has(key) ? "addressed" : lastReply > time(at) ? "replied" : "to_address");
  const out: FeedbackEntry[] = [];
  for (const r of d.reviews) {
    if (mine(r.author) || !r.body.trim()) continue;
    out.push({ key: r.url, kind: "review", author: r.author, bot: r.bot, at: r.submittedAt, state: said(r.url, r.submittedAt), reviewState: r.state, body: r.body, commitSince: commitSince(r.submittedAt) });
  }
  for (const c of d.comments) {
    if (mine(c.author)) continue;
    out.push({ key: c.url, kind: "comment", author: c.author, bot: c.bot, at: c.createdAt, state: isStatusReport(c) ? "report" : said(c.url, c.createdAt), body: c.body, commitSince: commitSince(c.createdAt) });
  }
  for (const t of d.threads) {
    const first = t.comments[0];
    const last = t.comments.at(-1);
    if (!first || !last) continue;
    const state: FeedbackState = marked.has(last.url) ? "addressed" : t.isOutdated ? "outdated" : mine(last.author) ? "replied" : "to_address";
    out.push({ key: last.url, kind: "thread", author: first.author, bot: first.bot, at: last.createdAt, state, thread: t, commitSince: commitSince(last.createdAt) });
  }
  // People before bots: a bot posts many entries, and a person's one request must not drown in them.
  return out.sort((a, b) => Number(a.bot) - Number(b.bot) || time(b.at) - time(a.at));
}

const STATE_WORDS: [FeedbackState, string][] = [
  ["to_address", "to address"],
  ["replied", "replied"],
  ["outdated", "outdated"],
  ["addressed", "marked addressed"],
  ["report", "report"],
];

/** "2 to address · 1 replied": only the states that have entries. */
export function feedbackCounts(entries: FeedbackEntry[]): string {
  return STATE_WORDS.map(([s, word]) => [entries.filter((e) => e.state === s).length, word] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(" · ");
}

/** What the rule reads. The board's search has no bodies for comments and threads, and needs none. */
export type FeedbackSource = Pick<PrDetail, "author" | "reviews" | "comments" | "threads" | "lastCommitAt" | "addressed">;

/** The entries that still need an answer from the PR author. */
export function toAddressCount(d: FeedbackSource): number {
  return feedback(d).filter((e) => e.state === "to_address").length;
}
