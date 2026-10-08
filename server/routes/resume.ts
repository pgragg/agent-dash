import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config.ts";
import { isRunning, startConversation } from "../conversations.ts";
import type { ParsedSession, SessionIndex } from "../sources/sessions.ts";
import { isAlive, readReportedStatuses, type ReportedStatus } from "../sources/status.ts";

/**
 * Why a session cannot be resumed here, or null. Two pi processes on one log would interleave
 * their entries, so only a session that is known to be closed resumes.
 */
export function resumeBlocker(s: ParsedSession | undefined, reported: ReportedStatus | undefined, opts: { running: boolean; alive?: (pid: number) => boolean }): string | null {
  if (!s) return "no such session";
  // The spawn comes seconds before pi writes its status file, so a second click sees no live pid yet.
  if (opts.running) return "this session is still running";
  const folderGone = !s.cwd || !existsSync(s.cwd) || !statSync(s.cwd).isDirectory() ? `its folder is gone: ${s.cwd}` : null;
  // OpenCode's service owns the session and takes a message at any time: there is no second process to collide with.
  if (s.agent === "opencode") return folderGone;
  // Without a status file, a terminal can still have it open. Copy resume is the way then.
  if (!reported) return "the dash cannot tell whether a terminal still has this session open";
  // A pid that is alive, even after "closed": the process can still be on its way out.
  if ((opts.alive ?? isAlive)(reported.pid)) return "this session is still running";
  return folderGone;
}

async function readMessage(req: IncomingMessage): Promise<string | undefined> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) return undefined;
  }
  try {
    const text = (JSON.parse(body || "{}") as { message?: unknown }).message;
    return typeof text === "string" && text.trim() ? text.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `POST /api/conversations/resume?session=<id>`: continue a finished session headless, under its own id.
 * An optional `{message}` is the first reply, so a parked agent gets its answer as it starts.
 */
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
  const blocker = resumeBlocker(s, reported.get(sessionId), { running: isRunning(sessionId) });
  if (blocker) return json(s ? 409 : 404, { error: blocker });
  const message = await readMessage(req);
  return json(201, { sessionId: startConversation({ cwd: s!.cwd, message, resume: { sessionId, sessionFile: s!.sessionFile }, agent: s!.agent }) });
}
