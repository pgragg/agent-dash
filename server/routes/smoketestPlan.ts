import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { ENV_LABEL, isSmoketestRunning } from "../../shared/sdlc.ts";
import type { AgentKind } from "../../shared/team.ts";
import { config } from "../config.ts";
import { isRunning, startConversation } from "../conversations.ts";
import { agentMessage, agentName } from "../handoff.ts";
import { startExecution } from "../sdlc.ts";
import type { SessionIndex } from "../sources/sessions.ts";
import { isAlive, readReportedStatuses } from "../sources/status.ts";
import * as db from "../summaries/db.ts";
import { deliver } from "./liveControl.ts";
import { resumeBlocker } from "./resume.ts";

export interface PlanDeps {
  sessions: SessionIndex;
  /** The handoff context of a ticket, for a new agent. Null for a ticket the dash does not show. */
  context: (key: string) => Promise<string | null>;
  /** The script that agents record with, so the message names this dash's own copy. */
  script: string;
  /** The GitHub login that a Confirm records. */
  login: () => Promise<string>;
  onChange: () => void;
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > max) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Where the run message goes: the planning agent, if it can still take a message, else a new agent. */
type Target = { kind: "inbox"; sessionId: string } | { kind: "resume"; sessionId: string; cwd: string; sessionFile: string; agent: AgentKind } | { kind: "new"; sessionId: string };

async function pickTarget(sessionId: string | null, sessions: SessionIndex): Promise<Target> {
  if (sessionId) {
    const status = (await readReportedStatuses(config.statusDir)).get(sessionId);
    if (status?.inbox && status.state !== "closed" && isAlive(status.pid)) return { kind: "inbox", sessionId };
    const parsed = (await sessions.scan()).find((p) => p.sessionId === sessionId);
    if (parsed && !resumeBlocker(parsed, status, { running: isRunning(sessionId) })) return { kind: "resume", sessionId, cwd: parsed.cwd, sessionFile: parsed.sessionFile, agent: parsed.agent };
  }
  return { kind: "new", sessionId: randomUUID() };
}

/**
 * `POST /api/sdlc-events/run?id=<plan id>` with `{ plannedAt, cwd }`: Piper's Confirm of a plan,
 * which approves the state changes that it lists, and starts its run. On a plan that is already
 * accepted, it starts another run. The planning agent runs it when it can still take a message,
 * so it keeps what it learned while it planned.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, deps: PlanDeps): Promise<boolean> {
  if (url.pathname !== "/api/sdlc-events/run" || req.method !== "POST") return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    return true;
  };
  // Same CSRF guard as the other POST routes: this approves writes and starts a pi process.
  if (req.headers["x-agent-dash"] !== "1") return json(403, { error: "missing X-Agent-Dash header" });
  let body: { plannedAt?: string; cwd?: string };
  try {
    body = JSON.parse((await readBody(req, 16_000)) || "{}");
  } catch (err) {
    return json(400, { error: (err as Error).message });
  }
  const id = Number(url.searchParams.get("id"));
  let plan = db.getSdlcEvent(id);
  if (plan?.eventType !== "smoketest_plan") return json(404, { error: "no such smoketest plan" });
  if (!plan.plannedAt) return json(409, { error: "the agent has not recorded the plan yet" });
  if (db.sdlcEventsByTicket()[plan.tickets[0]]?.some((e) => e.planId === plan!.id && isSmoketestRunning(e))) return json(409, { error: "this plan is already running" });

  const dir = (body.cwd?.trim() || homedir()).replace(/^~(?=\/|$)/, homedir());
  const target = await pickTarget(plan.sessionId, deps.sessions);
  if (target.kind === "new" && (!dir.startsWith("/") || !existsSync(dir) || !statSync(dir).isDirectory())) return json(400, { error: `not a folder: ${body.cwd}` });
  const context = target.kind === "new" ? await deps.context(plan.tickets[0]) : null;
  if (target.kind === "new" && context === null) return json(404, { error: `the dash does not show ${plan.tickets[0]}, so it cannot start a new agent for it` });

  const confirming = !plan.confirmedAt;
  if (confirming) {
    // The page sends the version it showed: a confirmation approves one exact text.
    let by: string;
    try {
      by = await deps.login();
    } catch {
      return json(503, { error: "cannot read your GitHub login: run `gh auth login`, then confirm again" });
    }
    const confirmed = db.confirmPlan(id, body.plannedAt ?? "", by);
    if (!confirmed) return json(409, { error: "the plan changed since the page loaded it: read the new version, then confirm again" });
    plan = confirmed;
  }
  let executionId: number | null = null;
  try {
    const { execution, message } = startExecution(plan, target.sessionId, deps.script);
    executionId = execution.id;
    const key = plan.tickets[0];
    if (target.kind === "inbox") deliver(target.sessionId, "txt", message);
    else if (target.kind === "resume") startConversation({ cwd: target.cwd, message, resume: { sessionId: target.sessionId, sessionFile: target.sessionFile }, agent: target.agent });
    else startConversation({ cwd: dir, message: agentMessage(context!, message), name: agentName(key, `Run the smoketest plan on ${ENV_LABEL[plan.environments[0]]}`), sessionId: target.sessionId });
    deps.onChange();
    return json(201, { ok: true, sessionId: target.sessionId, execution });
  } catch (err) {
    // A run that never started must not show as running, nor leave the plan confirmed.
    if (executionId !== null) db.deleteSdlcEvent(executionId);
    if (confirming) db.unconfirmPlan(id);
    deps.onChange();
    return json(500, { error: (err as Error).message });
  }
}
