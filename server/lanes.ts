import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { keySlug } from "../shared/lanes.ts";
import type { LaneGit, LaneMode, WorkLane } from "../shared/types.ts";

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 16_000_000 });
  return stdout.trim();
}

const ok = (cwd: string, ...args: string[]) => git(cwd, ...args).then(() => true, () => false);

/** A request that git state refuses. The message is for Piper. */
export class LaneError extends Error {}

export interface LanePlan {
  repo: string;
  mode: LaneMode;
  base: string;
  /** Null in "pr" mode. `create` is false when the integration worktree is already there. */
  integration: { branch: string; worktree: string; create: boolean } | null;
  lanes: { lane: string; branch: string; worktree: string; from: string }[];
}

/**
 * Where each worktree goes, checked before anything changes. Folders are siblings of the main
 * checkout, as the agent-dash AGENTS.md asks: `../<repo>-<key>-<lane>`.
 */
export async function planLanes(dir: string, key: string, names: string[], mode: LaneMode, base?: string): Promise<LanePlan> {
  const common = await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir").catch(() => {
    throw new LaneError(`not in a git repo: ${dir}`);
  });
  const repo = dirname(common);
  // A rebase in a shallow clone replays the graft commit, and merge-base fails once the base moves.
  if ((await git(repo, "rev-parse", "--is-shallow-repository")) === "true") throw new LaneError(`${repo} is a shallow clone. Run \`git fetch --unshallow\` there first.`);
  const branch = base?.trim().replace(/^origin\//, "") || (await git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "")).replace(/^origin\//, "");
  if (!branch) throw new LaneError("origin has no default branch here; name the base branch");

  const slug = keySlug(key);
  const folder = (suffix: string) => join(dirname(repo), `${basename(repo)}-${suffix}`);
  const worktrees = await listWorktrees(repo);
  const branchExists = (b: string) => ok(repo, "show-ref", "--verify", "--quiet", `refs/heads/${b}`);

  let integration: LanePlan["integration"] = null;
  if (mode === "land") {
    const worktree = folder(slug);
    const there = worktrees.find((w) => w.path === worktree);
    if (there && there.branch !== slug) throw new LaneError(`${worktree} is a worktree on ${there.branch ?? "a detached HEAD"}, not ${slug}`);
    if (!there && existsSync(worktree)) throw new LaneError(`${worktree} exists and is not a worktree of ${repo}`);
    const elsewhere = worktrees.find((w) => w.branch === slug && w.path !== worktree);
    if (elsewhere) throw new LaneError(`branch ${slug} is checked out in ${elsewhere.path}`);
    integration = { branch: slug, worktree, create: !there };
  }

  const lanes: LanePlan["lanes"] = [];
  for (const lane of names) {
    const b = `${slug}-${lane}`;
    const worktree = folder(b);
    if (existsSync(worktree)) throw new LaneError(`${worktree} exists already`);
    if (await branchExists(b)) throw new LaneError(`branch ${b} exists already`);
    lanes.push({ lane, branch: b, worktree, from: integration?.branch ?? `origin/${branch}` });
  }
  return { repo, mode, base: branch, integration, lanes };
}

/** Makes the planned worktrees. On a failure, removes the ones this call made, which hold no work yet. */
export async function createLanes(plan: LanePlan): Promise<void> {
  const { repo, base, integration } = plan;
  await git(repo, "fetch", "--quiet", "origin", base).catch((err: Error) => {
    throw new LaneError(`git fetch origin ${base} failed: ${err.message.split("\n").slice(-2).join(" ")}`);
  });
  // An integration branch that was there before keeps its commits on a rollback.
  const made: { branch: string | null; worktree: string }[] = [];
  try {
    if (integration?.create) {
      if (await ok(repo, "show-ref", "--verify", "--quiet", `refs/heads/${integration.branch}`)) {
        await git(repo, "worktree", "add", integration.worktree, integration.branch);
        made.push({ branch: null, worktree: integration.worktree });
      } else {
        // --no-track: a pull in the worktree must not merge the base by surprise.
        await git(repo, "worktree", "add", "--no-track", "-b", integration.branch, integration.worktree, `origin/${base}`);
        made.push(integration);
      }
    }
    for (const l of plan.lanes) {
      await git(repo, "worktree", "add", "--no-track", "-b", l.branch, l.worktree, l.from);
      made.push(l);
    }
  } catch (err) {
    for (const m of made.reverse()) {
      await git(repo, "worktree", "remove", m.worktree).catch(() => {});
      if (m.branch) await git(repo, "branch", "-D", m.branch).catch(() => {});
    }
    throw new LaneError(`git worktree add failed: ${(err as Error).message.split("\n").slice(-2).join(" ")}`);
  }
}

export async function listWorktrees(repo: string): Promise<{ path: string; branch: string | null }[]> {
  const out = await git(repo, "worktree", "list", "--porcelain");
  return out
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "";
      const ref = lines.find((l) => l.startsWith("branch "))?.slice(7) ?? null;
      return { path, branch: ref?.replace(/^refs\/heads\//, "") ?? null };
    });
}

/** The ref a lane counts ahead and behind against. */
export function laneBaseRef(l: Pick<WorkLane, "mode" | "base" | "integrationBranch">): string {
  return l.mode === "land" && l.integrationBranch ? l.integrationBranch : `origin/${l.base}`;
}

/** The lane's git state now, or null when its worktree is gone. Reads only. */
export async function laneGit(l: Pick<WorkLane, "worktree" | "mode" | "base" | "integrationBranch">): Promise<LaneGit | null> {
  if (!existsSync(l.worktree)) return null;
  try {
    const [head, counts, status] = await Promise.all([
      git(l.worktree, "branch", "--show-current"),
      git(l.worktree, "rev-list", "--left-right", "--count", `${laneBaseRef(l)}...HEAD`),
      git(l.worktree, "status", "--porcelain"),
    ]);
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    return { head: head || null, ahead, behind, dirty: status ? status.split("\n").length : 0 };
  } catch {
    return null;
  }
}
