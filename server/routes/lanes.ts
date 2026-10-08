import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { laneAgentName, laneBrief, lanesProblem, type LaneRequest } from "../../shared/lanes.ts";
import type { LaneMode, WorkLane } from "../../shared/types.ts";
import { config } from "../config.ts";
import { newSessionId, startConversation } from "../conversations.ts";
import { agentMessage } from "../handoff.ts";
import { landFailureMessage, landLane, type LandOutcome } from "../land.ts";
import { createLanes, git, LaneError, laneGit, planLanes } from "../lanes.ts";
import { readReportedStatuses, resolveReported } from "../sources/status.ts";
import { deliver } from "./liveControl.ts";
import * as db from "../summaries/db.ts";

export interface StartLanesInput {
  key: string;
  /** The ticket context that every agent started from the page gets. */
  context: string;
  /** The folder Piper picked: the repo's main checkout or any worktree of it. */
  cwd: string;
  lanes: unknown;
  mode: unknown;
  base?: unknown;
  /** Text that every lane gets before its own message. */
  brief?: unknown;
}

/**
 * Makes one worktree per lane (and the ticket's integration worktree in "land" mode), saves the
 * lane rows, and starts one headless agent in each worktree.
 */
export async function startLanes(input: StartLanesInput, start = startConversation): Promise<{ status: number; body: unknown }> {
  const problem = lanesProblem(input.lanes);
  if (problem) return { status: 400, body: { error: problem } };
  if (input.mode !== "land" && input.mode !== "pr") return { status: 400, body: { error: "laneMode must be land or pr" } };
  const mode: LaneMode = input.mode;
  const lanes = input.lanes as LaneRequest[];
  const brief = typeof input.brief === "string" ? input.brief.trim() : "";

  let plan;
  try {
    plan = await planLanes(input.cwd, input.key, lanes.map((l) => l.name), mode, typeof input.base === "string" ? input.base : undefined);
    await createLanes(plan);
  } catch (err) {
    if (err instanceof LaneError) return { status: 409, body: { error: err.message } };
    throw err;
  }

  const rows = plan.lanes.map((p, i) =>
    db.addLane({
      ticket: input.key,
      repo: plan.repo,
      lane: p.lane,
      mode,
      base: plan.base,
      branch: p.branch,
      worktree: p.worktree,
      integrationBranch: plan.integration?.branch ?? null,
      integrationWorktree: plan.integration?.worktree ?? null,
      sessionId: newSessionId(),
      goal: lanes[i].message.trim(),
    }),
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(config.handoffDir, { recursive: true });
  for (const row of rows) {
    const text = [laneBrief(input.key, row, rows.filter((r) => r.id !== row.id)), brief, row.goal].filter(Boolean).join("\n\n");
    writeFileSync(join(config.handoffDir, `${input.key}-${row.lane}-${stamp}.md`), input.context);
    start({ cwd: row.worktree, message: agentMessage(input.context, text), name: laneAgentName(input.key, row.lane, row.goal), sessionId: row.sessionId! });
  }
  return { status: 201, body: { ok: true, integration: plan.integration?.worktree ?? null, lanes: rows.map((r) => ({ id: r.id, lane: r.lane, sessionId: r.sessionId, worktree: r.worktree })) } };
}

/** Each active lane with its git state, by ticket key. */
export async function lanesByTicket(): Promise<Record<string, WorkLane[]>> {
  const out: Record<string, WorkLane[]> = {};
  const rows = db.activeLanes();
  // One count per integration worktree, shared by its lanes.
  const integrations = [...new Map(rows.filter((r) => r.integrationWorktree).map((r) => [r.integrationWorktree!, r])).values()];
  const [states, ahead] = await Promise.all([
    Promise.all(rows.map((r) => laneGit(r))),
    Promise.all(integrations.map((r) => (existsSync(r.integrationWorktree!) ? git(r.integrationWorktree!, "rev-list", "--count", `origin/${r.base}..${r.integrationBranch}`).then(Number, () => null) : null))),
  ]);
  const aheadOf = new Map(integrations.map((r, i) => [r.integrationWorktree!, ahead[i]]));
  rows.forEach((r, i) => (out[r.ticket] ??= []).push({ ...r, git: states[i], integrationAhead: r.integrationWorktree ? (aheadOf.get(r.integrationWorktree) ?? null) : null }));
  return out;
}

/** One land at a time per ticket: each land rebases onto what the one before it landed. */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(ticket: string, job: () => Promise<T>): Promise<T> {
  const next = (queues.get(ticket) ?? Promise.resolve()).then(job, job);
  queues.set(ticket, next.catch(() => {}));
  return next;
}

export interface LaneRouteDeps {
  /** The ticket context that an agent started from the page gets, or null for an unknown ticket. */
  context: (key: string) => Promise<string | null>;
  onChange: () => void;
  /** Whether the session's agent is working now. */
  agentWorking?: (sessionId: string) => Promise<boolean>;
  land?: typeof landLane;
  start?: typeof startConversation;
  inbox?: typeof deliver;
}

async function isWorking(sessionId: string): Promise<boolean> {
  const s = (await readReportedStatuses(config.statusDir)).get(sessionId);
  return !!s && resolveReported(s).status === "working";
}

/**
 * Lands a lane into its ticket's integration branch. On a conflict or red checks, the lane's
 * agent gets a message with the files or the output, so it can fix the lane itself.
 */
export async function land(id: number, deps: LaneRouteDeps): Promise<{ status: number; body: unknown }> {
  const lane = db.getLane(id);
  if (!lane || lane.state === "removed") return { status: 404, body: { error: "no such lane" } };
  return enqueue(lane.ticket, async () => {
    const before = db.getLane(id)!;
    db.setLaneState(id, "landing", null);
    deps.onChange();
    const working = before.sessionId ? await (deps.agentWorking ?? isWorking)(before.sessionId) : false;
    const out = await (deps.land ?? landLane)(before, { agentWorking: working }).catch((err: Error): LandOutcome => ({ ok: false, kind: "refused", message: err.message }));
    if (out.ok) db.setLaneState(id, "landed", `landed ${out.landed} commit${out.landed === 1 ? "" : "s"}${out.checks.length ? ` after ${out.checks.join(" and ")}` : " (no checks found)"}`);
    else if (out.kind === "refused") db.setLaneState(id, before.state === "landing" ? "working" : before.state, out.message);
    else {
      db.setLaneState(id, out.kind === "conflict" ? "conflict" : "checks_failed", out.message);
      if (before.sessionId) await (deps.inbox ?? deliver)(before.sessionId, "txt", landFailureMessage(before, out));
    }
    deps.onChange();
    return out.ok ? { status: 200, body: out } : { status: out.kind === "refused" ? 409 : 200, body: out };
  });
}

/** What the agent that opens the ticket's PR reads after the ticket context. */
export function prMessage(key: string, title: string, lanes: Pick<WorkLane, "lane" | "goal" | "state" | "integrationBranch" | "base">[]): string {
  const first = lanes[0];
  return [
    `Open the PR for ${key}. The parallel lanes of this ticket landed into branch \`${first.integrationBranch}\`, and this folder is its worktree.`,
    "",
    ...lanes.map((l) => `- lane \`${l.lane}\` (${l.state === "landed" ? "landed" : `not landed: ${l.state}`}): ${l.goal.trim().split("\n")[0].slice(0, 120)}`),
    "",
    `Push \`${first.integrationBranch}\` to origin and open a PR into \`${first.base}\` titled \`${key}: ${title}\`. Follow the repo's AGENTS.md for the body and the checks. Do not rebase or amend: the lanes are built on these commits.`,
  ].join("\n");
}

/** Starts an agent in the integration worktree that pushes the branch and opens the ticket's PR. */
export async function openPr(key: string, title: string, deps: LaneRouteDeps): Promise<{ status: number; body: unknown }> {
  const lanes = db.activeLanes().filter((l) => l.ticket === key && l.integrationWorktree);
  if (!lanes.length) return { status: 404, body: { error: `${key} has no lanes that land` } };
  const worktree = lanes[0].integrationWorktree!;
  if (!existsSync(worktree)) return { status: 409, body: { error: `the integration worktree is gone: ${worktree}` } };
  if (!lanes.some((l) => l.state === "landed")) return { status: 409, body: { error: "land a lane first" } };
  const context = await deps.context(key);
  if (context === null) return { status: 404, body: { error: `unknown ticket ${key}` } };
  const message = prMessage(key, title, lanes);
  const sessionId = (deps.start ?? startConversation)({ cwd: worktree, message: agentMessage(context, message), name: `${key}/pr: open the PR from ${lanes[0].integrationBranch}` });
  return { status: 201, body: { ok: true, sessionId } };
}

/** `POST /api/lanes/land?id=<n>` and `POST /api/lanes/pr?ticket=<KEY>&title=<title>`. */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, deps: LaneRouteDeps): Promise<boolean> {
  if (!url.pathname.startsWith("/api/lanes/") || req.method !== "POST") return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    return true;
  };
  // Same CSRF guard as the other POST routes: these run git and start pi.
  if (req.headers["x-agent-dash"] !== "1") return json(403, { error: "missing X-Agent-Dash header" });
  if (url.pathname === "/api/lanes/land") {
    const out = await land(Number(url.searchParams.get("id")), deps);
    return json(out.status, out.body);
  }
  if (url.pathname === "/api/lanes/pr") {
    const out = await openPr(url.searchParams.get("ticket") ?? "", url.searchParams.get("title") ?? "", deps);
    if (out.status === 201) deps.onChange();
    return json(out.status, out.body);
  }
  return json(404, { error: "no such lanes route" });
}
