import { execFile } from "node:child_process";
import type { FeedbackSource } from "../../shared/feedback.ts";
import type { CheckState, PullRequest } from "../../shared/types.ts";
import { extractTickets } from "./sessions.ts";

/**
 * Run a command and return { stdout, code }. Unlike promisify(execFile), this does not reject on
 * non-zero exit codes, so we can handle partial GraphQL errors (e.g. SAML) where `gh` returns valid
 * data but exits 1.
 */
function run(cmd: string, args: string[], opts: { timeout: number; maxBuffer?: number }): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout, maxBuffer: opts.maxBuffer, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

const PR_FIELDS = `url number title state isDraft headRefName reviewDecision mergeable mergeStateStatus updatedAt
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state contexts(first: 50) { nodes { ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } }`;

/** GitHub charges for each nested page that it could return, so these cost about 50 of the 55 points. */
const FEEDBACK_FIELDS = `author { login }
        reviews(last: 30) { nodes { author { login __typename } state body submittedAt url } }
        comments(last: 30) { nodes { author { login __typename } createdAt url } }
        reviewThreads(first: 50) { nodes { isResolved isOutdated comments(last: 1) { nodes { author { login __typename } createdAt url } } } }`;

const searchQuery = (fields: string) => `query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        ${fields}
      }
    }
  }
}`;

export function checkState(rollup: string | undefined): CheckState {
  if (!rollup) return "none";
  if (rollup === "SUCCESS") return "success";
  if (rollup === "FAILURE" || rollup === "ERROR") return "failure";
  return "pending";
}

/** One check run or status context, as GraphQL returns it. */
export interface RawContext {
  name?: string;
  conclusion?: string | null;
  status?: string;
  context?: string;
  state?: string;
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

/** "failure", "success", "pending", "skipped", "neutral": lower case, the same for both kinds of check. */
export function contextState(c: RawContext): string {
  const v = c.context !== undefined ? c.state : c.conclusion;
  if (!v) return "pending";
  if (FAILED.has(v)) return "failure";
  if (v === "EXPECTED" || v === "PENDING") return "pending";
  return v.toLowerCase();
}

export const contextName = (c: RawContext): string => c.name ?? c.context ?? "?";

/** The failing check names, once each: a re-run job shows up again with the same name. */
export function failedCheckNames(contexts: RawContext[]): string[] {
  return [...new Set(contexts.filter((c) => contextState(c) === "failure").map(contextName))];
}

/** nitpickybot is a plain user account, so the login counts too. */
export const isBot = (author: any) => author?.__typename === "Bot" || /bot(\[bot\])?$/i.test(author?.login ?? "");

/** A search result, with what the feedback rule reads. The server counts it, then drops it. */
export type PullWithFeedback = PullRequest & { feedback?: Omit<FeedbackSource, "addressed"> };

/**
 * The feedback of an open PR as the rule reads it. Only the last comment of a thread decides its
 * state, and its text is not read, so the search asks for neither. A conversation comment's text
 * tells a bot's status report from a request.
 */
export function feedbackOf(n: any): Omit<FeedbackSource, "addressed"> {
  const person = (a: any) => ({ author: a?.login ?? "ghost", bot: isBot(a) });
  return {
    author: n.author?.login ?? null,
    reviews: (n.reviews?.nodes ?? []).filter(Boolean).map((r: any) => ({ ...person(r.author), state: r.state, body: r.body ?? "", submittedAt: r.submittedAt, url: r.url })),
    comments: (n.comments?.nodes ?? []).filter(Boolean).map((c: any) => ({ ...person(c.author), body: c.body ?? "", createdAt: c.createdAt, url: c.url })),
    threads: (n.reviewThreads?.nodes ?? [])
      .filter((t: any) => t && !t.isResolved)
      .map((t: any) => ({ path: "", line: null, isOutdated: !!t.isOutdated, comments: (t.comments?.nodes ?? []).map((c: any) => ({ ...person(c.author), body: "", createdAt: c.createdAt, url: c.url })) })),
    lastCommitAt: n.commits?.nodes?.[0]?.commit?.committedDate ?? null,
  };
}

async function searchPrs(q: string, ticketPattern: RegExp, withFeedback: boolean): Promise<PullWithFeedback[]> {
  const query = searchQuery(withFeedback ? `${PR_FIELDS}\n        ${FEEDBACK_FIELDS}` : PR_FIELDS);
  const { stdout, code } = await run("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `q=${q}`], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  // gh exits 1 on partial errors (e.g. SAML) but still returns valid data; use it if present.
  const json = stdout ? JSON.parse(stdout) : null;
  if (!json?.data?.search?.nodes && code !== 0) throw new Error(`gh api graphql exited ${code}`);
  const nodes: any[] = json?.data?.search?.nodes ?? [];
  return nodes
    .filter((n) => n?.url)
    .map((n) => ({
      url: n.url,
      repo: n.repository.nameWithOwner,
      number: n.number,
      title: n.title,
      state: n.state === "MERGED" ? "merged" : n.state === "CLOSED" ? "closed" : "open",
      isDraft: n.isDraft,
      headRef: n.headRefName,
      reviewDecision: n.reviewDecision ?? null,
      checks: checkState(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
      failedChecks: failedCheckNames(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []),
      mergeable: n.mergeable ?? "UNKNOWN",
      mergeStateStatus: n.mergeStateStatus ?? "UNKNOWN",
      updatedAt: n.updatedAt,
      tickets: extractTickets(`${n.title} ${n.headRefName}`, ticketPattern),
      ...(withFeedback && n.state === "OPEN" ? { feedback: feedbackOf(n) } : {}),
    }));
}

let login: Promise<string> | null = null;

/** The `gh` user's login, read once. A failed read is tried again on the next call. */
export function ghLogin(): Promise<string> {
  login ??= run("gh", ["api", "user", "--jq", ".login"], { timeout: 15_000 }).then(
    ({ stdout, code }) => {
      if (code !== 0 || !stdout.trim()) {
        login = null;
        throw new Error(`gh api user exited ${code}`);
      }
      return stdout.trim();
    },
  );
  return login;
}

/** My PRs updated in the window. Uses the `gh` login, so no token is stored here. */
export function fetchMyPrs(sinceDays: number, ticketPattern: RegExp): Promise<PullWithFeedback[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  return searchPrs(`is:pr author:@me updated:>=${since}`, ticketPattern, true);
}

/**
 * Every PR by anyone, of any age, with the key in its title. The dashboard's list holds only my
 * recent PRs, so an old merged PR or a deploy PR by someone else would be missing from it.
 */
export async function fetchTicketPrs(key: string, ticketPattern: RegExp): Promise<PullRequest[]> {
  // Search matches words, so FSDK-12 would also find FSDK-123; keep only exact keys.
  // No feedback fields: the SDLC bar does not read them, and they are most of the search's cost.
  return (await searchPrs(`is:pr in:title "${key}"`, ticketPattern, false)).filter((p) => p.tickets.includes(key));
}
