import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

/**
 * Start a headless pi (`--mode rpc`) whose only UI is the dash page.
 *
 * The first message goes through the reply inbox, as every later reply does: the status
 * extension delivers it when the session starts. The session id is chosen here, so the page
 * can open the conversation before pi has written anything.
 */
export function startConversation(cwd: string, message: string): string {
  const sessionId = randomUUID();
  const inbox = join(config.inboxDir, sessionId);
  mkdirSync(inbox, { recursive: true });
  // The extension reads *.txt only, so the rename makes the message appear whole.
  writeFileSync(join(inbox, "0.txt.tmp"), message);
  renameSync(join(inbox, "0.txt.tmp"), join(inbox, "0.txt"));

  mkdirSync(config.conversationsDir, { recursive: true });
  // rpc mode exits when stdin ends. A FIFO opened read-write is its own writer, so stdin never
  // ends, and the run outlives a server restart as summary runs do.
  const fifo = join(config.conversationsDir, `${sessionId}.in`);
  execFileSync("mkfifo", [fifo]);
  const stdin = openSync(fifo, "r+");
  const log = openSync(join(config.conversationsDir, `${sessionId}.log`), "a");
  // A copied ITERM_SESSION_ID would make "Open in iTerm" focus the tab that started the dash.
  const { ITERM_SESSION_ID: _tab, ...env } = process.env;
  const child = spawn("pi", ["--mode", "rpc", "--session-id", sessionId], {
    cwd,
    detached: true,
    stdio: [stdin, log, log],
    // The `pi` shell alias sets this; a spawned pi does not get the alias.
    env: { ...env, SSL_CERT_FILE: env.SSL_CERT_FILE ?? "/etc/ssl/cert.pem" },
  });
  closeSync(stdin);
  closeSync(log);
  const cleanup = () => rmSync(fifo, { force: true });
  child.on("exit", cleanup);
  // Without a listener, a failed spawn (no `pi` on PATH) would crash the server.
  child.on("error", cleanup);
  child.unref();
  return sessionId;
}
