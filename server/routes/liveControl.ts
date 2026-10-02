import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { config } from "../config.ts";
import { newestOpenDialog, readLogTail, sameDialog, type UiAnswer, uiResponse, writeFifoLine } from "../rpc.ts";
import { isAlive, readReportedStatuses, takesControls } from "../sources/status.ts";

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

/** Drop a file in the session's inbox; the rename makes it appear whole to the extension. */
export function writeInbox(sessionId: string, suffix: "txt" | "steer" | "abort", text: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error("not a session id");
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
    if (reply.steer && !takesControls(status)) return done(409, { error: "type /reload in the session to steer from here" });
    writeInbox(sessionId, reply.steer ? "steer" : "txt", reply.text.trim());
    return done(202, { ok: true });
  }

  if (url.pathname === "/api/stop") {
    if (!takesControls(status)) return done(409, { error: "type /reload in the session to stop it from here" });
    writeInbox(sessionId, "abort", "");
    return done(202, { ok: true });
  }

  // Only a headless run reads its stdin from a FIFO; a terminal dialog is answered in iTerm.
  if (status.mode !== "rpc") return done(409, { error: "answer this dialog in its iTerm tab" });
  if (!status.dialog) return done(409, { error: "no dialog is open" });
  // The cap keeps an answer far below the pipe buffer, so the FIFO write never waits.
  const answer = await body<UiAnswer>(32_000);
  if (!answer) return done(400, { error: "the answer is not JSON" });
  const log = await readLogTail(join(config.conversationsDir, `${sessionId}.log`)).catch(() => "");
  const request = newestOpenDialog(log, answered);
  // The status file says which dialog is open; never answer a different one.
  if (!request || !sameDialog(request, status.dialog)) return done(409, { error: "the dialog is gone" });
  const out = uiResponse(request, answer);
  if ("error" in out) return done(400, out);
  try {
    writeFifoLine(join(config.conversationsDir, `${sessionId}.in`), out.line);
  } catch {
    return done(409, { error: "the session no longer reads its input" });
  }
  answered.add(request.id);
  if (answered.size > 200) answered.delete(answered.values().next().value!);
  return done(202, { ok: true });
}
