import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckState, PullRequest } from "../../shared/types.ts";
import { extractTickets } from "./sessions.ts";

const run = promisify(execFile);

const QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        url number title state isDraft headRefName reviewDecision mergeable updatedAt
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

function checkState(rollup: string | undefined): CheckState {
  if (!rollup) return "none";
  if (rollup === "SUCCESS") return "success";
  if (rollup === "FAILURE" || rollup === "ERROR") return "failure";
  return "pending";
}

/** My PRs updated in the window. Uses the `gh` login, so no token is stored here. */
export async function fetchMyPrs(sinceDays: number, ticketPattern: RegExp): Promise<PullRequest[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const { stdout } = await run(
    "gh",
    ["api", "graphql", "-f", `query=${QUERY}`, "-f", `q=is:pr author:@me updated:>=${since}`],
    { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
  );
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
      mergeable: n.mergeable ?? "UNKNOWN",
      updatedAt: n.updatedAt,
      tickets: extractTickets(`${n.title} ${n.headRefName}`, ticketPattern),
    }));
}
