import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

export interface ConversationOptions {
  cwd: string;
  /** The first message. A resumed session can start without one and wait for a reply. */
  message?: string;
  /** The session display name; a ticket key in it links the run to the ticket. A resume keeps the file's name. */
  name?: string;
  /** The id of a new run, when the caller needs it first. */
  sessionId?: string;
  /** Called when pi cannot start, for example when it is not on PATH. */
  onSpawnError?: () => void;
  /** Continue this session file. pi keeps the id that the file holds. */
  resume?: { sessionId: string; sessionFile: string };
}

/** The pi arguments of a headless run. A new run gets the id that the server picked. */
export function rpcArgs(sessionId: string, opts: Pick<ConversationOptions, "name" | "resume">): string[] {
  const args = ["--mode", "rpc", ...(opts.resume ? ["--session", opts.resume.sessionFile] : ["--session-id", sessionId])];
  if (opts.name && !opts.resume) args.push("--name", opts.name);
  return args;
}

/** Runs this server started that have not exited. pi writes its status file only seconds after the spawn. */
const running = new Set<string>();

export function isRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

/**
 * Start a headless pi (`--mode rpc`) whose only UI is the dash page.
 *
 * The first message goes through the reply inbox, as every later reply does: the status
 * extension delivers it when the session starts. The session id is chosen here, so the page
 * can open the conversation before pi has written anything.
 */
export function startConversation(opts: ConversationOptions): string {
  const sessionId = opts.resume?.sessionId ?? opts.sessionId ?? randomUUID();
  if (opts.message) {
    const inbox = join(config.inboxDir, sessionId);
    mkdirSync(inbox, { recursive: true });
    // The extension reads *.txt only, so the rename makes the message appear whole.
    writeFileSync(join(inbox, "0.txt.tmp"), opts.message);
    renameSync(join(inbox, "0.txt.tmp"), join(inbox, "0.txt"));
  }

  mkdirSync(config.conversationsDir, { recursive: true });
  // rpc mode exits when stdin ends. A FIFO opened read-write is its own writer, so stdin never
  // ends, and the run outlives a server restart as summary runs do.
  const fifo = join(config.conversationsDir, `${sessionId}.in`);
  // A server restart skips the exit cleanup, so a resumed id can find its old FIFO.
  rmSync(fifo, { force: true });
  execFileSync("mkfifo", [fifo]);
  const ino = statSync(fifo).ino;
  const stdin = openSync(fifo, "r+");
  const log = openSync(join(config.conversationsDir, `${sessionId}.log`), "a");
  // A copied ITERM_SESSION_ID would make "Open in iTerm" focus the tab that started the dash.
  const { ITERM_SESSION_ID: _tab, ...env } = process.env;
  const child = spawn("pi", rpcArgs(sessionId, opts), {
    cwd: opts.cwd,
    detached: true,
    stdio: [stdin, log, log],
    // The `pi` shell alias sets this; a spawned pi does not get the alias.
    env: { ...env, SSL_CERT_FILE: env.SSL_CERT_FILE ?? "/etc/ssl/cert.pem" },
  });
  closeSync(stdin);
  closeSync(log);
  // An ended run can exit after its resume made a new FIFO at the same path; keep that one.
  running.add(sessionId);
  const cleanup = () => {
    running.delete(sessionId);
    if (statSync(fifo, { throwIfNoEntry: false })?.ino === ino) rmSync(fifo, { force: true });
  };
  child.on("exit", cleanup);
  // Without a listener, a failed spawn (no `pi` on PATH) would crash the server.
  child.on("error", () => {
    cleanup();
    opts.onSpawnError?.();
  });
  child.unref();
  return sessionId;
}
