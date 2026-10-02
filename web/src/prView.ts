import { checkList } from "../../shared/prVerbs.ts";
import type { Dashboard, PullRequest, Run } from "../../shared/types.ts";

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
