import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { config } from "../config.ts";
import { newestOpenDialog, readLogTail, sameDialog, type UiAnswer, uiResponse, writeFifoLine } from "../rpc.ts";
import { isAlive, readReportedStatuses, takesControls } from "../sources/status.ts";

/** Stop a run, and answer an extension dialog of a headless run. */

/** Dialog ids this server answered. The log holds only the requests, never the answers. */
const answered = new Set<string>();

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > max) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Drop a file in the session's inbox; the rename makes it appear whole to the extension. */
export function writeInbox(sessionId: string, suffix: "txt" | "steer" | "abort", text: string): void {
  const dir = join(config.inboxDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${process.pid}.${suffix}`);
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "POST" || (url.pathname !== "/api/stop" && url.pathname !== "/api/dialog")) return false;
  const done = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    return true;
  };
  // Same CSRF guard as /api/focus: a custom header forces a preflight that is never answered.
  if (req.headers["x-agent-dash"] !== "1") return done(403, { error: "missing X-Agent-Dash header" });
  const sessionId = url.searchParams.get("session") ?? "";
  const status = (await readReportedStatuses(config.statusDir)).get(sessionId);
  if (!status || status.state === "closed" || !isAlive(status.pid)) return done(404, { error: "no live session" });

  if (url.pathname === "/api/stop") {
    if (!takesControls(status)) return done(409, { error: "this session cannot stop from here; type /reload in the session" });
    writeInbox(sessionId, "abort", "");
    return done(202, { ok: true });
  }

  // Only a headless run reads its stdin from a FIFO; a terminal dialog is answered in iTerm.
  if (status.mode !== "rpc") return done(409, { error: "answer this dialog in its iTerm tab" });
  if (!status.dialog) return done(409, { error: "no dialog is open" });
  const log = await readLogTail(join(config.conversationsDir, `${sessionId}.log`)).catch(() => "");
  const request = newestOpenDialog(log, answered);
  // The status file says which dialog is open; never answer a different one.
  if (!request || !sameDialog(request, status.dialog)) return done(409, { error: "the dialog is gone" });
  const answer = JSON.parse((await readBody(req, 32_000)) || "{}") as UiAnswer;
  const out = uiResponse(request, answer);
  if ("error" in out) return done(400, out);
  writeFifoLine(join(config.conversationsDir, `${sessionId}.in`), out.line);
  answered.add(request.id);
  return done(202, { ok: true });
}
