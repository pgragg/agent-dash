import type { AttentionKind } from "./types.ts";

/**
 * The first message of an agent that a PR verb button starts. The dash itself never writes to
 * GitHub, so each message tells the agent to read fresh state with `gh` and do one small task.
 * The click on the button is the approval for that task, and for nothing more.
 */

export interface VerbPr {
  url: string;
  /** "owner/repo". */
  repo: string;
  number: number;
  headRef?: string;
  failedChecks?: string[];
}

/** "lint, test, +2 more": enough names to know which job broke, short enough for one line. */
export function checkList(names: string[], max = 3): string {
  const more = names.length > max ? `, +${names.length - max} more` : "";
  return `${names.slice(0, max).join(", ")}${more}`;
}

const name = (pr: VerbPr) => `${pr.repo.split("/")[1]}#${pr.number}`;
const ticks = (names: string[]) => names.map((n) => `\`${n}\``).join(", ");
const branch = (pr: VerbPr) => (pr.headRef ? ` (branch \`${pr.headRef}\`)` : "");

/** A working copy is the user's; an agent that checks out a branch there must not lose their work. */
const checkout = (pr: VerbPr) =>
  `Work in a clone of ${pr.repo}. If the current folder is not one (\`git remote -v\`), find the clone, or clone it into a new folder. If the working tree has uncommitted changes, stop and ask me. Then run \`gh pr checkout ${pr.url}\`.`;

const noForce = "Push a new commit to the PR branch. Never force-push, amend, or rebase published commits.";

export function fixCi(pr: VerbPr): string {
  const failed = pr.failedChecks?.length ? ticks(pr.failedChecks) : null;
  return [
    `Fix CI on ${name(pr)}${failed ? `: ${checkList(pr.failedChecks!)}` : ""}`,
    "",
    `CI is red on ${pr.url}${branch(pr)}.${failed ? ` Failing checks: ${failed}.` : ""}`,
    "",
    `1. Run \`gh pr checks ${pr.url}\`, then read the failed log with \`gh run view <run-id> --log-failed\`.`,
    `2. ${checkout(pr)}`,
    "3. Find the cause and fix it. Run the failing check (tests, lint, typecheck) locally until it passes.",
    `4. ${noForce}`,
    "5. Report what failed, what you changed, and the commit.",
  ].join("\n");
}

export function addressReview(pr: VerbPr): string {
  return [
    `Address the review on ${name(pr)}`,
    "",
    `A reviewer asked for changes on ${pr.url}${branch(pr)}.`,
    "",
    `1. Read the unresolved review threads: \`gh pr view ${pr.url} --comments\`, and \`gh api graphql\` for \`reviewThreads\` where \`isResolved\` is false.`,
    `2. ${checkout(pr)}`,
    "3. Fix each thread. Run the tests.",
    `4. ${noForce}`,
    "5. Post nothing on GitHub: no reply, no review, no resolved thread. Draft a one-line reply for each thread, and show the drafts to me.",
  ].join("\n");
}

export function rebase(pr: VerbPr): string {
  return [
    `Fix the merge conflict on ${name(pr)}`,
    "",
    `${pr.url}${branch(pr)} has a merge conflict with its base branch.`,
    "",
    "1. Run `git rev-parse --is-shallow-repository` first. If it prints `true`, run `git fetch --unshallow` before you do anything else: a history rewrite in a shallow clone closes the PR for good.",
    `2. ${checkout(pr)}`,
    `3. Find the base branch (\`gh pr view ${pr.url} --json baseRefName\`), fetch it, and merge it into the PR branch. Prefer a merge to a rebase, because a merge needs no force-push.`,
    "4. Resolve each conflict so that both sides keep their intent. Run the tests.",
    `5. ${noForce}`,
    "6. Report which files had conflicts, and how you resolved each one.",
  ].join("\n");
}

export function merge(pr: VerbPr): string {
  return [
    `Merge ${name(pr)}`,
    "",
    `I approve: merge ${pr.url} now.`,
    "",
    `1. Check that it is still approved, green, and mergeable: \`gh pr view ${pr.url} --json reviewDecision,mergeStateStatus,statusCheckRollup\`. If it is not, stop and tell me why.`,
    `2. Get the repo's default merge method: \`gh repo view ${pr.repo} --json viewerDefaultMergeMethod\`.`,
    `3. Run \`gh pr merge ${pr.url}\` with that method (\`--merge\`, \`--squash\` or \`--rebase\`). Do not use \`--admin\` or \`--auto\`.`,
    "4. Report the result. Do nothing else.",
  ].join("\n");
}

export function draftNudge(pr: VerbPr): string {
  return [
    `Draft a review nudge for ${name(pr)}`,
    "",
    `${pr.url} is out for review and has had no review activity for days.`,
    "",
    `1. Read the PR and who must review it: \`gh pr view ${pr.url} --json title,body,reviewRequests,latestReviews\`.`,
    "2. Draft a friendly, one-paragraph reminder to those reviewers. Say in one sentence what the PR does and why it matters.",
    "3. Do NOT post it: no GitHub comment, no Slack message. Show me the draft only.",
  ].join("\n");
}

export type VerbId = "fix_ci" | "address_review" | "rebase" | "merge" | "nudge";

export interface PrVerb {
  id: VerbId;
  label: string;
  /** Asked before the agent starts, because the task cannot be undone. */
  confirm?: string;
  message: string;
}

/** The one verb for a PR signal, or null when the signal has none (for example a healthy review). */
export function verbFor(signal: { kind: AttentionKind; info?: boolean }, pr: VerbPr): PrVerb | null {
  switch (signal.kind) {
    case "ci_failing":
      return { id: "fix_ci", label: "Fix CI", message: fixCi(pr) };
    case "changes_requested":
      return { id: "address_review", label: "Address review", message: addressReview(pr) };
    case "merge_conflict":
      return { id: "rebase", label: "Rebase", message: rebase(pr) };
    case "ready_to_merge":
      return { id: "merge", label: "Merge", confirm: `Start an agent that merges ${name(pr)}? A merge cannot be undone.`, message: merge(pr) };
    case "in_review":
      // Only a stale review: a healthy one is context, with nothing to do.
      return signal.info ? null : { id: "nudge", label: "Draft a nudge", message: draftNudge(pr) };
    default:
      return null;
  }
}
