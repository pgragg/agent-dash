import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneAgentName, laneBrief, lanesProblem, type LaneRequest } from "../../shared/lanes.ts";
import type { LaneMode, WorkLane } from "../../shared/types.ts";
import { config } from "../config.ts";
import { startConversation } from "../conversations.ts";
import { agentMessage } from "../handoff.ts";
import { createLanes, LaneError, laneGit, planLanes } from "../lanes.ts";
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
      sessionId: randomUUID(),
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
  const states = await Promise.all(rows.map((r) => laneGit(r)));
  rows.forEach((r, i) => (out[r.ticket] ??= []).push({ ...r, git: states[i] }));
  return out;
}
