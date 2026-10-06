import type { PullRequest } from "./types.ts";

/**
 * GitHub says APPROVED when one approval counts, but a code-owner rule can still block the merge.
 * With green CI and no conflict, BLOCKED then means that the PR waits for the repo owner's review.
 */
export function awaitsOwner(pr: Pick<PullRequest, "reviewDecision" | "mergeStateStatus" | "checks" | "mergeable" | "isDraft">): boolean {
  return pr.reviewDecision === "APPROVED" && pr.mergeStateStatus === "BLOCKED" && !pr.isDraft && pr.checks !== "failure" && pr.checks !== "pending" && pr.mergeable !== "CONFLICTING";
}

/** "1 approval, awaiting approval by repo owner". The count is unknown on a PR fetched with no reviews. */
export function ownerWaitText(approvals: number | undefined): string {
  const got = approvals === undefined ? "approved" : approvals === 1 ? "1 approval" : `${approvals} approvals`;
  return `${got}, awaiting approval by repo owner`;
}

/** People whose latest review approves. A bot's approval does not satisfy a code-owner rule. */
export function approvalCount(reviews: { author: string; bot: boolean; state: string }[]): number {
  const latest = new Map<string, string>();
  for (const r of reviews) if (!r.bot && r.state !== "COMMENTED") latest.set(r.author.toLowerCase(), r.state);
  return [...latest.values()].filter((s) => s === "APPROVED").length;
}
