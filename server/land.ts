import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkLane } from "../shared/types.ts";
import { git } from "./lanes.ts";
import { user } from "../shared/team.ts";

const exec = promisify(execFile);

export type LandOutcome =
  | { ok: true; landed: number; checks: string[] }
  /** Nothing changed: the lane or the integration worktree is not ready. */
  | { ok: false; kind: "refused"; message: string }
  /** The rebase stopped and was aborted, so the lane is as it was. */
  | { ok: false; kind: "conflict"; message: string; files: string[] }
  /** The lane is rebased onto the integration branch, but its checks are red. */
  | { ok: false; kind: "checks"; message: string; output: string };

export interface CheckResult {
  ok: boolean;
  /** The commands that ran, and the tail of the output of the one that failed. */
  ran: string[];
  output: string;
}

/**
 * The repo's own checks: the `typecheck` and `test` scripts of its package.json, with the
 * package manager that its lockfile names. A repo with neither has no gate.
 */
export async function runChecks(dir: string): Promise<CheckResult> {
  const pkgFile = join(dir, "package.json");
  if (!existsSync(pkgFile)) return { ok: true, ran: [], output: "" };
  const scripts = (JSON.parse(readFileSync(pkgFile, "utf8")).scripts ?? {}) as Record<string, string>;
  const pm = existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(dir, "yarn.lock")) ? "yarn" : "npm";
  const ran: string[] = [];
  for (const script of ["typecheck", "test"].filter((s) => scripts[s])) {
    const cmd = `${pm} run ${script}`;
    ran.push(cmd);
    try {
      // A hung test must not hold the ticket's queue for ever.
      await exec(pm, ["run", script], { cwd: dir, timeout: 15 * 60_000, maxBuffer: 32_000_000, env: { ...process.env, CI: "1" } });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || e.message;
      return { ok: false, ran, output: out.split("\n").slice(-40).join("\n") };
    }
  }
  return { ok: true, ran, output: "" };
}

type LandLane = Pick<WorkLane, "lane" | "mode" | "branch" | "worktree" | "integrationBranch" | "integrationWorktree">;

/**
 * Lands one lane into its ticket's integration branch: rebase the lane onto it, run the checks
 * in the lane, then fast-forward the integration branch. The integration branch only moves on
 * green checks, so it never holds a conflict.
 */
export async function landLane(l: LandLane, opts: { agentWorking: boolean; checks?: (dir: string) => Promise<CheckResult> }): Promise<LandOutcome> {
  const refuse = (message: string): LandOutcome => ({ ok: false, kind: "refused", message });
  if (l.mode !== "land" || !l.integrationBranch || !l.integrationWorktree) return refuse("this lane opens its own PR; it does not land");
  // The rebase rewrites the files that the agent works on.
  if (opts.agentWorking) return refuse(`lane ${l.lane}'s agent is working. Land it when the agent stops.`);
  if (!existsSync(l.worktree)) return refuse(`the worktree of lane ${l.lane} is gone: ${l.worktree}`);
  if (!existsSync(l.integrationWorktree)) return refuse(`the integration worktree is gone: ${l.integrationWorktree}`);

  const [head, dirty, intHead, intDirty] = await Promise.all([
    git(l.worktree, "branch", "--show-current"),
    git(l.worktree, "status", "--porcelain"),
    git(l.integrationWorktree, "branch", "--show-current"),
    git(l.integrationWorktree, "status", "--porcelain"),
  ]);
  if (head !== l.branch) return refuse(`lane ${l.lane} is on ${head || "a detached HEAD"}, not ${l.branch}`);
  if (dirty) return refuse(`lane ${l.lane} has ${dirty.split("\n").length} uncommitted files. Ask its agent to commit them.`);
  // Another tool (the polish automation) can take the branch out of its worktree.
  if (intHead !== l.integrationBranch) return refuse(`the integration worktree is on ${intHead || "a detached HEAD"}, not ${l.integrationBranch}`);
  if (intDirty) return refuse(`the integration worktree ${l.integrationWorktree} has uncommitted files`);

  const ahead = Number(await git(l.worktree, "rev-list", "--count", `${l.integrationBranch}..HEAD`));
  if (!ahead) return refuse(`lane ${l.lane} has no commits that ${l.integrationBranch} does not have`);

  try {
    await git(l.worktree, "rebase", "--quiet", l.integrationBranch);
  } catch {
    const files = (await git(l.worktree, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
    await git(l.worktree, "rebase", "--abort").catch(() => {});
    return { ok: false, kind: "conflict", files, message: `lane ${l.lane} conflicts with ${l.integrationBranch} in ${files.join(", ") || "files git did not name"}` };
  }

  const checks = await (opts.checks ?? runChecks)(l.worktree);
  if (!checks.ok) return { ok: false, kind: "checks", output: checks.output, message: `lane ${l.lane} is rebased onto ${l.integrationBranch}, but \`${checks.ran.at(-1)}\` failed` };

  try {
    await git(l.integrationWorktree, "merge", "--quiet", "--ff-only", l.branch);
  } catch (err) {
    return refuse(`the fast-forward of ${l.integrationBranch} failed: ${(err as Error).message.split("\n").slice(-2).join(" ")}`);
  }
  return { ok: true, landed: ahead, checks: checks.ran };
}

/** What the lane's agent reads when its land fails, so it can fix the lane itself. */
export function landFailureMessage(l: Pick<WorkLane, "lane" | "branch" | "integrationBranch">, out: Exclude<LandOutcome, { ok: true } | { kind: "refused" }>): string {
  if (out.kind === "conflict") {
    return [
      `agent-dash could not land lane \`${l.lane}\`: \`${l.branch}\` conflicts with \`${l.integrationBranch}\`, which other lanes moved.`,
      "",
      `Conflicting files: ${out.files.map((f) => `\`${f}\``).join(", ") || "(git named none)"}.`,
      "",
      `Run \`git rebase ${l.integrationBranch}\` in this worktree, resolve the conflicts so that both changes stay, run the checks, and commit. Then stop, so that ${user()} can land the lane again.`,
    ].join("\n");
  }
  return [
    `agent-dash rebased lane \`${l.lane}\` onto \`${l.integrationBranch}\`, but the checks failed, so it did not land.`,
    "",
    "The end of the output:",
    "",
    "```",
    out.output,
    "```",
    "",
    `Fix the cause on this branch, commit, and stop, so that ${user()} can land the lane again.`,
  ].join("\n");
}
