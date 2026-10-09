import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { claudeInterruptLine, claudeUserLine } from "../agent.ts";
import { config } from "../config.ts";
import { fifoOf } from "../conversations.ts";
import { type OpencodeDialog, opencodeAnswerPermission, opencodeInterrupt, opencodeSend } from "../opencode.ts";
import { claudeResponse, newestOpenClaudeRequest, newestOpenDialog, readLogTail, sameDialog, type UiAnswer, uiResponse, writeFifoLine } from "../rpc.ts";
import type { RunDialog } from "../../shared/types.ts";
import { isAlive, patchReportedStatus, readReportedStatus, readReportedStatuses, type ReportedStatus, takesControls, takesSteer } from "../sources/status.ts";

/** Talk to a live session from the page: reply, steer, stop, and answer an extension dialog. */

const ROUTES = new Set(["/api/reply", "/api/stop", "/api/dialog"]);

/** A path segment, so a session id can never point outside the inbox or conversations folder. */
const SESSION_ID = /^[\w-]{8,64}$/;

/** Dialog ids this server answered: the log holds only the requests. Bounded, as old ids never come back. */
const answered = new Set<string>();

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

/**
 * Send a reply, a steer or a Stop to a live session. pi's extension reads them from the session's
 * inbox; a headless Claude Code reads them on its stdin; OpenCode's service takes them over HTTP.
 */
export function deliver(sessionId: string, suffix: "txt" | "steer" | "abort", text: string, status: ReportedStatus | undefined = readReportedStatus(config.statusDir, sessionId)): void | Promise<void> {
  if (!SESSION_ID.test(sessionId)) throw new Error("not a session id");
  if (status?.agent === "opencode") return suffix === "abort" ? opencodeInterrupt(sessionId) : opencodeSend(sessionId, text, suffix === "steer");
  if (status?.agent !== "claude") return writeInbox(sessionId, suffix, text);
  if (suffix !== "abort") return writeFifoLine(fifoOf(sessionId), claudeUserLine(text));
  writeFifoLine(fifoOf(sessionId), claudeInterruptLine());
  // An interrupt also closes an open permission request.
  patchReportedStatus(config.statusDir, sessionId, { state: "awaiting_input", since: new Date().toISOString(), activity: null, dialog: null });
}

/** Drop a file in the session's inbox; the rename makes it appear whole to the extension. */
function writeInbox(sessionId: string, suffix: "txt" | "steer" | "abort", text: string): void {
  const dir = join(config.inboxDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${process.pid}.${suffix}`);
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "POST" || !ROUTES.has(url.pathname)) return false;
  const done = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    return true;
  };
  const body = async <T>(max: number): Promise<T | null> => {
    try {
      return JSON.parse((await readBody(req, max)) || "{}") as T;
    } catch {
      return null;
    }
  };
  // Same CSRF guard as /api/focus: a custom header forces a preflight that is never answered.
  if (req.headers["x-agent-dash"] !== "1") return done(403, { error: "missing X-Agent-Dash header" });
  const sessionId = url.searchParams.get("session") ?? "";
  if (!SESSION_ID.test(sessionId)) return done(400, { error: "not a session id" });
  const status = (await readReportedStatuses(config.statusDir)).get(sessionId);
  // Deliver only to a live session whose extension watches the inbox; otherwise a file would sit unread.
  if (!status?.inbox || status.state === "closed" || !isAlive(status.pid)) return done(409, { error: "this session cannot take messages from here; open its tab" });

  if (url.pathname === "/api/reply") {
    const reply = await body<{ text?: string; steer?: boolean }>(64_000);
    if (!reply?.text?.trim()) return done(400, { error: "empty reply" });
    // An older extension reads *.txt only, and would never see a *.steer file.
    if (reply.steer && !takesSteer(status)) return done(409, { error: status.agent === "claude" ? "Claude Code cannot take a steer: queue the message, or stop the agent first" : "type /reload in the session to steer from here" });
    try {
      await deliver(sessionId, reply.steer ? "steer" : "txt", reply.text.trim(), status);
    } catch (err) {
      return done(409, { error: status.agent === "opencode" ? (err as Error).message : "the session no longer reads its input" });
    }
    return done(202, { ok: true });
  }

  if (url.pathname === "/api/stop") {
    if (!takesControls(status)) return done(409, { error: "type /reload in the session to stop it from here" });
    try {
      await deliver(sessionId, "abort", "", status);
    } catch (err) {
      return done(409, { error: status.agent === "opencode" ? (err as Error).message : "the session no longer reads its input" });
    }
    // An editor dialog takes no abort signal, so Stop cannot close it from the extension.
    if (status.dialog?.method !== "editor") return done(202, { ok: true });
    if (status.mode === "rpc" && (await answerOpenDialog(sessionId, status.dialog, { cancelled: true }, false)) === null) return done(202, { ok: true });
    return done(202, { ok: true, note: "The agent stops when the editor dialog closes. Close it in the session's tab." });
  }

  // Only a headless run reads its stdin from a FIFO; a terminal dialog is answered in iTerm.
  if (status.mode !== "rpc") return done(409, { error: "answer this dialog in its iTerm tab" });
  if (!status.dialog) return done(409, { error: "no dialog is open" });
  // The cap keeps an answer far below the pipe buffer, so the FIFO write never waits.
  const answer = await body<UiAnswer>(32_000);
  if (!answer) return done(400, { error: "the answer is not JSON" });
  if (status.agent === "opencode") {
    const err = await answerOpencode(sessionId, status.dialog as OpencodeDialog, answer);
    return err ? done(err.code, { error: err.error }) : done(202, { ok: true });
  }
  const err = await answerOpenDialog(sessionId, status.dialog, answer, status.agent === "claude");
  return err ? done(err.code, { error: err.error }) : done(202, { ok: true });
}

/**
 * Answer an OpenCode permission request by the id that the status file holds; a subagent's request
 * goes to the subagent's session. The service says when the request is gone.
 */
async function answerOpencode(sessionId: string, open: OpencodeDialog, answer: UiAnswer): Promise<{ code: number; error: string } | null> {
  const allow = "confirmed" in answer ? answer.confirmed : "cancelled" in answer ? false : null;
  if (typeof allow !== "boolean") return { code: 400, error: "a confirm dialog takes yes or no" };
  try {
    await opencodeAnswerPermission(open.sessionID ?? sessionId, open.id, allow);
  } catch (err) {
    return { code: 409, error: `the dialog is gone: ${(err as Error).message}` };
  }
  patchReportedStatus(config.statusDir, sessionId, { dialog: null });
  return null;
}

/** Write the answer to the dialog that the status file names. Returns null on success. */
async function answerOpenDialog(sessionId: string, open: RunDialog, answer: UiAnswer, claude: boolean): Promise<{ code: number; error: string } | null> {
  const log = await readLogTail(join(config.conversationsDir, `${sessionId}.log`)).catch(() => "");
  const claudeRequest = claude ? newestOpenClaudeRequest(log, answered) : null;
  const request = claude ? claudeRequest : newestOpenDialog(log, answered);
  // Never answer a different dialog than the one the status file says is open.
  if (!request || !sameDialog(request, open)) return { code: 409, error: "the dialog is gone" };
  const out = claudeRequest ? claudeResponse(claudeRequest, answer) : uiResponse(request, answer);
  if ("error" in out) return { code: 400, error: out.error };
  try {
    writeFifoLine(fifoOf(sessionId), out.line);
  } catch {
    return { code: 409, error: "the session no longer reads its input" };
  }
  // No hook fires on a denied request, so the dialog would stay on the page.
  if (claude) patchReportedStatus(config.statusDir, sessionId, { dialog: null });
  answered.add(request.id);
  if (answered.size > 200) answered.delete(answered.values().next().value!);
  return null;
}
