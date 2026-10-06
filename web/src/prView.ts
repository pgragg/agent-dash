import { checkList } from "../../shared/prVerbs.ts";
import type { Dashboard, PrDetail, PrReviewThread, PullRequest, Run } from "../../shared/types.ts";

/** PR logic of the PR panel and the verb buttons. Kept free of React so the tests can import it. */

type Data = Pick<Dashboard, "myTickets" | "otherTickets" | "unlinkedRuns">;

const home = (cwd: string) => cwd.replace(/^\/Users\/[^/]+/, "~");

function allRuns(d: Data): Run[] {
  const runs = new Map<string, Run>();
  for (const r of [...d.myTickets, ...d.otherTickets].flatMap((g) => g.runs).concat(d.unlinkedRuns)) runs.set(r.sessionId, r);
  return [...runs.values()];
}

/** The newest run that opened the PR with `gh pr create`. */
export function openerRun(d: Data, url: string): Run | null {
  return allRuns(d).filter((r) => r.createdPrs.includes(url)).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0] ?? null;
}

/**
 * The ticket and folder for a verb's agent. The ticket must be on the board, because
 * /api/agents builds its context from the board. The folder is the opener's, because that
 * is the clone with the PR branch; else the folder the ticket's workspace offers first.
 */
export function verbStart(d: Data, pr: { url: string; tickets: string[] }, preferTicket?: string | null): { ticket: string | null; cwd: string } {
  const groups = new Map([...d.myTickets, ...d.otherTickets].map((g) => [g.ticket.key, g]));
  const keys = [preferTicket, ...pr.tickets].filter((k): k is string => !!k && groups.has(k));
  const ticket = keys[0] ?? null;
  const opener = openerRun(d, pr.url);
  if (opener?.cwd) return { ticket, cwd: home(opener.cwd) };
  const g = ticket ? groups.get(ticket)! : null;
  // Same rule as the workspace's folder list: the ticket's newest relevant run.
  const runs = (g?.runs ?? []).filter((r) => g!.threads[r.sessionId]?.status !== "resolved" && r.cwd);
  const newest = runs.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  return { ticket, cwd: newest ? home(newest.cwd) : "~" };
}

/** The PR's tag for its checks: "CI failure: lint, test" names what broke. */
export function ciTag(pr: Pick<PullRequest, "checks" | "failedChecks">): { text: string; tone: string; title?: string } | null {
  if (pr.checks === "none") return null;
  const tone = pr.checks === "success" ? "good" : pr.checks === "failure" ? "bad" : "warn";
  const names = pr.checks === "failure" && pr.failedChecks?.length ? pr.failedChecks : null;
  return names ? { text: `CI failure: ${checkList(names, 2)}`, tone, title: names.join("\n") } : { text: `CI ${pr.checks}`, tone };
}

/** "pr:owner/repo/N" as owner/repo/N and its GitHub URL, or null for an address that is not a PR. */
export function panelTarget(ref: string): { path: string; url: string } | null {
  const m = ref.match(/^pr:([^/\s]+\/[^/\s]+)\/(\d+)$/);
  return m ? { path: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/pull/${m[2]}` } : null;
}

export type FeedbackState = "to_address" | "replied" | "outdated" | "addressed";

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
export function feedback(d: Pick<PrDetail, "author" | "reviews" | "comments" | "threads" | "lastCommitAt" | "addressed">): FeedbackEntry[] {
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
    out.push({ key: c.url, kind: "comment", author: c.author, bot: c.bot, at: c.createdAt, state: said(c.url, c.createdAt), body: c.body, commitSince: commitSince(c.createdAt) });
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
];

/** "2 to address · 1 replied": only the states that have entries. */
export function feedbackCounts(entries: FeedbackEntry[]): string {
  return STATE_WORDS.map(([s, word]) => [entries.filter((e) => e.state === s).length, word] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(" · ");
}
