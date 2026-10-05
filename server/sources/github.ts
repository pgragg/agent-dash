import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckState, PullRequest } from "../../shared/types.ts";
import { extractTickets } from "./sessions.ts";

const run = promisify(execFile);

const QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        url number title state isDraft headRefName reviewDecision mergeable mergeStateStatus updatedAt
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes { ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } }
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

async function searchPrs(q: string, ticketPattern: RegExp): Promise<PullRequest[]> {
  const { stdout } = await run("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-f", `q=${q}`], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  const nodes: any[] = JSON.parse(stdout).data?.search?.nodes ?? [];
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
    }));
}

/** My PRs updated in the window. Uses the `gh` login, so no token is stored here. */
export function fetchMyPrs(sinceDays: number, ticketPattern: RegExp): Promise<PullRequest[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  return searchPrs(`is:pr author:@me updated:>=${since}`, ticketPattern);
}

/**
 * Every PR by anyone, of any age, with the key in its title. The dashboard's list holds only my
 * recent PRs, so an old merged PR or a deploy PR by someone else would be missing from it.
 */
export async function fetchTicketPrs(key: string, ticketPattern: RegExp): Promise<PullRequest[]> {
  // Search matches words, so FSDK-12 would also find FSDK-123; keep only exact keys.
  return (await searchPrs(`is:pr in:title "${key}"`, ticketPattern)).filter((p) => p.tickets.includes(key));
}
