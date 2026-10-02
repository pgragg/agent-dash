import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config.ts";
import { startConversation } from "../conversations.ts";
import { heuristicStatus, type ParsedSession, type SessionIndex } from "../sources/sessions.ts";
import { isAlive, readReportedStatuses, type ReportedStatus } from "../sources/status.ts";

/**
 * Why a session cannot be resumed here, or null. Two pi processes on one log would interleave
 * their entries, so a session that can still be open does not resume.
 */
export function resumeBlocker(s: ParsedSession | undefined, reported: ReportedStatus | undefined, now: number, alive: (pid: number) => boolean = isAlive): string | null {
  if (!s) return "no such session";
  // A pid that is alive, even after "closed": the process can still be on its way out.
  if (reported && alive(reported.pid)) return "this session is still running";
  if (!reported && heuristicStatus(s, now).status !== "finished") return "this session can still be open in a terminal";
  if (!s.cwd || !existsSync(s.cwd) || !statSync(s.cwd).isDirectory()) return `its folder is gone: ${s.cwd}`;
  return null;
}

/** `POST /api/conversations/resume?session=<id>`: continue a finished session headless, under its own id. */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, sessions: SessionIndex): Promise<boolean> {
  if (url.pathname !== "/api/conversations/resume" || req.method !== "POST") return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    return true;
  };
  // Same CSRF guard as the other POST routes: this starts a pi process.
  if (req.headers["x-agent-dash"] !== "1") return json(403, { error: "missing X-Agent-Dash header" });
  const sessionId = url.searchParams.get("session") ?? "";
  // The log path comes from the server's own scan, never from the request.
  const [parsed, reported] = await Promise.all([sessions.scan(), readReportedStatuses(config.statusDir)]);
  const s = parsed.find((p) => p.sessionId === sessionId);
  const blocker = resumeBlocker(s, reported.get(sessionId), Date.now());
  if (blocker) return json(s ? 409 : 404, { error: blocker });
  return json(201, { sessionId: startConversation({ cwd: s!.cwd, resume: { sessionId, sessionFile: s!.sessionFile } }) });
}
