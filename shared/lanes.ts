import type { LaneMode, WorkLane } from "./types.ts";

/** A lane name becomes part of a branch and a folder name, so it stays short and plain. */
export const LANE_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const MAX_LANES = 6;

export interface LaneRequest {
  name: string;
  message: string;
}

/** Why the lanes in a request cannot start, or null. */
export function lanesProblem(lanes: unknown): string | null {
  if (!Array.isArray(lanes) || lanes.length < 2) return "give at least two lanes";
  if (lanes.length > MAX_LANES) return `give at most ${MAX_LANES} lanes`;
  const names = new Set<string>();
  for (const l of lanes as Partial<LaneRequest>[]) {
    if (typeof l?.name !== "string" || !LANE_NAME.test(l.name)) return `not a lane name: ${String(l?.name)} (use a-z, 0-9 and -)`;
    if (names.has(l.name)) return `two lanes are named ${l.name}`;
    names.add(l.name);
    if (typeof l.message !== "string" || !l.message.trim()) return `write the first message of lane ${l.name}`;
  }
  return null;
}

/** The ticket key as it shows in branch and folder names: `AD-20` → `ad-20`. */
export function keySlug(key: string): string {
  return key.toLowerCase();
}

/** The session name carries the key, so the lane's run links to the ticket at once. */
export function laneAgentName(key: string, lane: string, text: string): string {
  return `${key}/${lane}: ${text.replace(/[*`]/g, "").trim().split("\n")[0].slice(0, 60)}`;
}

/** A port per lane, so lanes that run a dev server do not take the same one. */
export function lanePort(id: number): number {
  return 7800 + (id % 200);
}

type BriefLane = Pick<WorkLane, "id" | "lane" | "branch" | "worktree" | "base" | "integrationBranch" | "goal"> & { mode: LaneMode };

/** What a lane's agent reads first: where it works, who else works, and how its work comes back. */
export function laneBrief(key: string, me: BriefLane, others: Pick<WorkLane, "lane" | "goal">[]): string {
  const firstLine = (s: string) => s.trim().split("\n")[0].slice(0, 120);
  const back =
    me.mode === "land"
      ? `Commit your work on \`${me.branch}\` in small commits. Do not push, and do not open a PR: agent-dash lands each lane into \`${me.integrationBranch}\`, and one PR goes out from there. When agent-dash sends you a conflict report, rebase onto \`${me.integrationBranch}\` and resolve it.`
      : `Commit your work on \`${me.branch}\`. When the work is done and the checks pass, push \`${me.branch}\` and open a PR into \`${me.base}\` with \`${key}\` in its title, as the repo's AGENTS.md says.`;
  return [
    "## Your lane",
    "",
    `You are lane \`${me.lane}\` of ${key}. ${others.length + 1} agents work on this ticket at the same time, each in its own git worktree.`,
    "",
    `- Work only in \`${me.worktree}\`, on branch \`${me.branch}\`. Do not check out another branch, and do not edit files in another lane's folder.`,
    `- The other lanes: ${others.map((o) => `\`${o.lane}\` (${firstLine(o.goal)})`).join("; ")}. Keep out of the files that their work needs. If you must change a shared file, keep the change small.`,
    `- Install the dependencies first if the repo needs them (for example \`pnpm install\`). If you start a server, use port ${lanePort(me.id)}.`,
    `- ${back}`,
  ].join("\n");
}

/** The lane's git state in a few words, and whether it needs a look. */
export function laneGitText(l: Pick<WorkLane, "git" | "branch" | "mode" | "base" | "integrationBranch">): { text: string; warn: boolean } {
  if (!l.git) return { text: "worktree gone", warn: true };
  if (l.git.head !== l.branch) return { text: `on ${l.git.head ?? "a detached HEAD"}, not ${l.branch}`, warn: true };
  const base = l.mode === "land" && l.integrationBranch ? l.integrationBranch : `origin/${l.base}`;
  const parts = [l.git.ahead ? `${l.git.ahead} ahead` : "no commits yet", ...(l.git.behind ? [`${l.git.behind} behind ${base}`] : []), ...(l.git.dirty ? [`${l.git.dirty} uncommitted`] : [])];
  return { text: parts.join(" · "), warn: false };
}
