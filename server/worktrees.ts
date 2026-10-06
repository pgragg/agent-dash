import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { WorktreeInfo } from "../shared/types.ts";
import { git, listWorktrees } from "./lanes.ts";
import type { LaneRecord } from "./summaries/db.ts";

const exec = promisify(execFile);

/** An orphan used this recently can belong to a session that cd'ed into it, which no status file shows. */
export const QUIET_MS = 24 * 3_600_000;

export interface Facts {
  main: boolean;
  branch: string | null;
  dirty: number;
  ahead: number;
  contained: boolean;
  prState: string | null;
  lastUsedAt: string | null;
  liveSession: string | null;
  owned: boolean;
  /** A lane whose commits are all on its ticket's integration branch. */
  landed?: boolean;
  /** An integration worktree that active lanes still branch from and land into. */
  lanesUseIt?: boolean;
}

/**
 * Why a worktree must stay, or null. Clean up never loses work: no uncommitted files, no live
 * agent, and no commits that only this branch holds unless the branch itself stays.
 */
export function cleanupBlocker(f: Facts, now: number): string | null {
  if (f.main) return "the repo's main checkout";
  if (f.liveSession) return "a live agent works here";
  if (f.lanesUseIt) return "its lanes still land here; clean them up first";
  if (f.dirty) return `${f.dirty} uncommitted file${f.dirty === 1 ? "" : "s"}`;
  // A detached HEAD has no branch to keep its commits.
  if (!f.branch && !f.contained) return `a detached HEAD with ${f.ahead} commit${f.ahead === 1 ? "" : "s"} that the base does not have`;
  if (!f.owned && f.lastUsedAt && now - Date.parse(f.lastUsedAt) < QUIET_MS) return "used in the last 24 hours";
  return null;
}

/** The branch goes only when its work is safe elsewhere: on the base, or in a merged PR (a squash merge leaves the commits off the base). */
export function deletesBranch(f: Pick<Facts, "branch" | "contained" | "prState" | "landed">): boolean {
  return !!f.branch && (f.contained || f.prState === "MERGED" || !!f.landed);
}

/** `owner/repo` of origin on GitHub, or null. */
async function githubRepo(repo: string): Promise<string | null> {
  const url = await git(repo, "remote", "get-url", "origin").catch(() => "");
  return url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null;
}

const prCache = new Map<string, { at: number; value: { url: string; state: string } | null }>();

/** The newest PR from this branch, open, merged or closed. Read-only `gh`, cached for 5 minutes. */
async function prFor(slug: string, branch: string): Promise<{ url: string; state: string } | null> {
  const key = `${slug}#${branch}`;
  const hit = prCache.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  const value = await exec("gh", ["pr", "list", "--repo", slug, "--head", branch, "--state", "all", "--limit", "1", "--json", "url,state"])
    .then(({ stdout }) => (JSON.parse(stdout) as { url: string; state: string }[])[0] ?? null)
    .catch(() => null);
  prCache.set(key, { at: Date.now(), value });
  return value;
}

/** When git last moved this worktree's HEAD. The index is not used: a plain `git status` rewrites it. */
async function lastUsed(path: string): Promise<string | null> {
  const gitDir = await git(path, "rev-parse", "--path-format=absolute", "--git-dir").catch(() => "");
  for (const f of [join(gitDir, "logs", "HEAD"), gitDir]) if (gitDir && existsSync(f)) return statSync(f).mtime.toISOString();
  return null;
}

export interface ScanInput {
  repos: string[];
  lanes: LaneRecord[];
  /** Live pi sessions and the folder each one started in. */
  live: { sessionId: string; cwd: string }[];
  now: number;
  pr?: (slug: string, branch: string) => Promise<{ url: string; state: string } | null>;
}

/** Every worktree of the repos, with what Clean up would do to each. Reads only. */
export async function scanWorktrees(input: ScanInput): Promise<WorktreeInfo[]> {
  const out: WorktreeInfo[] = [];
  for (const repo of [...new Set(input.repos)].filter((r) => existsSync(r))) {
    const base = (await git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "origin/main")).replace(/^origin\//, "");
    const slug = await githubRepo(repo);
    const trees = await listWorktrees(repo);
    out.push(
      ...(await Promise.all(
        trees.map(async (t): Promise<WorktreeInfo> => {
          const lane = input.lanes.find((l) => l.worktree === t.path);
          const integration = input.lanes.find((l) => l.integrationWorktree === t.path);
          const owner = lane ? { ticket: lane.ticket, laneId: lane.id, lane: lane.lane } : integration ? { ticket: integration.ticket, laneId: null, lane: null } : null;
          const there = existsSync(t.path);
          const [status, counts, contained, pr, used, landed] = await Promise.all([
            there ? git(t.path, "status", "--porcelain").catch(() => "") : "",
            git(repo, "rev-list", "--left-right", "--count", `origin/${base}...${t.branch ?? t.head}`).catch(() => "0 0"),
            git(repo, "merge-base", "--is-ancestor", t.branch ?? t.head, `origin/${base}`).then(() => true, () => false),
            t.branch && slug && t.path !== repo ? (input.pr ?? prFor)(slug, t.branch) : null,
            there ? lastUsed(t.path) : null,
            lane?.integrationBranch && t.branch ? git(repo, "merge-base", "--is-ancestor", t.branch, lane.integrationBranch).then(() => true, () => false) : false,
          ]);
          const [behind, ahead] = counts.split(/\s+/).map(Number);
          const liveSession = input.live.find((s) => s.cwd === t.path || s.cwd.startsWith(`${t.path}/`))?.sessionId ?? null;
          const facts: Facts = { main: t.path === repo, branch: t.branch, dirty: status ? status.split("\n").length : 0, ahead, contained, prState: pr?.state ?? null, lastUsedAt: used, liveSession, owned: !!owner, landed, lanesUseIt: !!integration && !lane };
          return {
            repo,
            path: t.path,
            branch: t.branch,
            owner,
            base,
            ahead,
            behind,
            contained,
            dirty: facts.dirty,
            pr,
            lastUsedAt: used,
            liveSession,
            blocker: cleanupBlocker(facts, input.now),
            deletesBranch: deletesBranch(facts),
          };
        }),
      )),
    );
  }
  return out;
}

/**
 * Removes one worktree, and its branch when its work is safe. The caller gives a fresh scan of
 * that worktree, so the checks run on the state of now, not on what the page showed.
 */
export async function removeWorktree(w: WorktreeInfo): Promise<{ ok: true; deletedBranch: boolean } | { ok: false; error: string }> {
  if (w.blocker) return { ok: false, error: `cannot clean up ${w.path}: ${w.blocker}` };
  try {
    // No --force: git refuses a worktree with changes that appeared since the scan.
    if (existsSync(w.path)) await git(w.repo, "worktree", "remove", w.path);
    else await git(w.repo, "worktree", "prune");
  } catch (err) {
    return { ok: false, error: (err as Error).message.split("\n").filter(Boolean).slice(-1)[0] ?? "git worktree remove failed" };
  }
  if (!w.deletesBranch || !w.branch) return { ok: true, deletedBranch: false };
  // -D, because a squash-merged branch is not merged as far as git can tell; deletesBranch checked the PR.
  const deleted = await git(w.repo, "branch", "-D", w.branch).then(() => true, () => false);
  return { ok: true, deletedBranch: deleted };
}

/** The main checkout of the repo that holds this folder, or null. */
export async function mainCheckout(dir: string): Promise<string | null> {
  const common = await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir").catch(() => "");
  return common ? dirname(common) : null;
}
