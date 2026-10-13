import type { IncomingMessage, ServerResponse } from "node:http";
import { agentBoard, agentRoot, agentRun, agentTicket, type Origin } from "../../shared/agentView.ts";
import { boardSections, buildSubjects } from "../../shared/board.ts";
import { runsOf } from "../../shared/notify.ts";
import type { Dashboard } from "../../shared/types.ts";
import { isMarked } from "../../shared/untilChange.ts";
import { config } from "../config.ts";
import { isAlive, readReportedStatuses } from "../sources/status.ts";

/**
 * Agent mode (`/api/agent/*`): the board as small JSON with the next actions on each object, for a
 * coding agent that drives agent-dash. See `shared/agentView.ts` and `skills/agent-dash/SKILL.md`.
 */

const WAIT_MAX_S = 600;
const POLL_MS = 1_000;

type RunState = "working" | "awaiting_input" | "finished";

/** The run's state from its status file: the file says "closed", or its process is gone. */
async function runState(sessionId: string): Promise<RunState | null> {
  const s = (await readReportedStatuses(config.statusDir)).get(sessionId);
  if (!s) return null;
  if (s.state === "closed" || (s.agent !== "opencode" && !isAlive(s.pid))) return "finished";
  return s.state;
}

function origin(req: IncomingMessage, url: URL): Origin {
  // A proxy (Caddy for agent-dash.test) sets the scheme; the links then open on the same name.
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
  return { base: `${proto}://${req.headers.host ?? `127.0.0.1:${config.port}`}`, full: url.searchParams.get("full") === "1" };
}

export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, dashboard: () => Promise<Dashboard>): Promise<boolean> {
  if (url.pathname !== "/api/agent" && !url.pathname.startsWith("/api/agent/")) return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    return true;
  };
  if (req.method !== "GET") return json(405, { error: "GET only: the actions in each answer name the POST routes" });
  const o = origin(req, url);

  if (url.pathname === "/api/agent/wait") {
    const sessionId = url.searchParams.get("session") ?? "";
    const want = url.searchParams.get("for") === "finished" ? "finished" : "stop";
    const timeout = Math.min(Math.max(Number(url.searchParams.get("timeout")) || 300, 1), WAIT_MAX_S);
    let closed = false;
    req.on("close", () => (closed = true));
    const done = (s: RunState | null) => (s === null ? false : want === "finished" ? s === "finished" : s !== "working");
    const deadline = Date.now() + timeout * 1000;
    let state = await runState(sessionId);
    // A run that the dash just started writes its status file a few seconds later.
    while (!closed && !done(state) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      state = await runState(sessionId);
    }
    if (closed) return true;
    const d = await dashboard();
    const run = runsOf(d).find((r) => r.sessionId === sessionId);
    if (!run && state === null) return json(404, { error: "no status file and no run on the board with that session id" });
    return json(200, { sessionId, status: state ?? run?.status ?? null, timedOut: !done(state), ...(run && { run: agentRun(d, run, o, null, { message: true }) }) });
  }

  const d = await dashboard();
  const subjects = buildSubjects(d);
  const sections = boardSections(d, subjects, Date.now(), (s) => isMarked(d.untilChange, s));

  if (url.pathname === "/api/agent") return json(200, agentRoot(d, sections, o));
  if (url.pathname === "/api/agent/board") return json(200, agentBoard(d, sections, o));
  if (url.pathname === "/api/agent/ticket") {
    const key = url.searchParams.get("key") ?? "";
    const s = subjects.get(`t:${key}`);
    if (!s?.ticket) return json(404, { error: `${key} is not on the board. GET /api/ticket?key=${key} reads it from its tracker.` });
    return json(200, agentTicket(d, sections, s, o));
  }
  if (url.pathname === "/api/agent/run") {
    const sessionId = url.searchParams.get("session") ?? "";
    const run = runsOf(d).find((r) => r.sessionId === sessionId);
    if (!run) return json(404, { error: "no run on the board with that session id. GET /api/transcript?session= reads an older one." });
    const ticket = run.tickets[0] ?? null;
    return json(200, { schema: "agent-dash/agent/v1", ...agentRun(d, run, o, ticket, { message: true }) });
  }
  return json(404, { error: "unknown agent route. Start at GET /api/agent." });
}
