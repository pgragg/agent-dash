import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "../shared/team.ts";
import { agentEnv, claudeUserLine, headlessCommand } from "./agent.ts";
import { config } from "./config.ts";
import { ASK_BEFORE_CHANGES, closeOpencodeStatus, markOpencodeWorking, newOpencodeSessionId, opencodeCreate, opencodeInterrupt, opencodeSend, startOpencodeStatus } from "./opencode.ts";
import { writeFifoSoon } from "./rpc.ts";
import type { ReportedStatus } from "./sources/status.ts";

export interface ConversationOptions {
  cwd: string;
  /** The first message. A resumed session can start without one and wait for a reply. */
  message?: string;
  /** The session display name; a ticket key in it links the run to the ticket. A resume keeps the file's name. */
  name?: string;
  /** The id of a new run, when the caller needs it first. */
  sessionId?: string;
  /** Called when the agent cannot start, for example when it is not on PATH. */
  onSpawnError?: () => void;
  /** Continue this session file. pi keeps the id that the file holds. */
  resume?: { sessionId: string; sessionFile: string };
  /** The agent that runs it; a resume takes the agent that wrote the session. Default: the configured one. */
  agent?: AgentKind;
  /** Claude Code tools that run without a permission dialog. */
  allowedTools?: string[];
  /** OpenCode asks on the page before a shell command or a file change. */
  askBeforeChanges?: boolean;
}

/** A new session's id, picked by the dash so the page can open it at once. OpenCode wants a "ses" prefix. */
export const newSessionId = (agent = config.agent): string => (agent === "opencode" ? newOpencodeSessionId() : randomUUID());

/** The stdin FIFO of a headless run. */
export const fifoOf = (sessionId: string): string => join(config.conversationsDir, `${sessionId}.in`);

/** Runs this server started that have not exited. pi writes its status file only seconds after the spawn. */
const running = new Set<string>();

export function isRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

/**
 * Start a headless agent whose only UI is the dash page.
 *
 * pi's first message goes through the reply inbox, as every later reply does: the status
 * extension delivers it when the session starts. Claude Code reads it on stdin. The session id
 * is chosen here, so the page can open the conversation before the agent has written anything.
 */
export function startConversation(opts: ConversationOptions): string {
  const agent = opts.agent ?? config.agent;
  const sessionId = opts.resume?.sessionId ?? opts.sessionId ?? newSessionId(agent);
  if (agent === "opencode") return startOpencode(sessionId, opts);
  if (opts.message && agent === "pi") {
    const inbox = join(config.inboxDir, sessionId);
    mkdirSync(inbox, { recursive: true });
    // The extension reads *.txt only, so the rename makes the message appear whole.
    writeFileSync(join(inbox, "0.txt.tmp"), opts.message);
    renameSync(join(inbox, "0.txt.tmp"), join(inbox, "0.txt"));
  }

  mkdirSync(config.conversationsDir, { recursive: true });
  // A headless run exits when stdin ends. A FIFO opened read-write is its own writer, so stdin
  // never ends, and the run outlives a server restart as summary runs do.
  const fifo = fifoOf(sessionId);
  // A server restart skips the exit cleanup, so a resumed id can find its old FIFO.
  rmSync(fifo, { force: true });
  execFileSync("mkfifo", [fifo]);
  const ino = statSync(fifo).ino;
  const stdin = openSync(fifo, "r+");
  const log = openSync(join(config.conversationsDir, `${sessionId}.log`), "a");
  // A copied ITERM_SESSION_ID would make "Open in iTerm" focus the tab that started the dash.
  const { ITERM_SESSION_ID: _tab, ...env } = process.env;
  const { cmd, args } = headlessCommand(agent, sessionId, opts);
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    detached: true,
    stdio: [stdin, log, log],
    // AGENT_DASH_MODE tells the Claude Code hook that the page is this run's only UI.
    env: { ...agentEnv(env), AGENT_DASH_MODE: "rpc" },
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
  // The context can be larger than the pipe buffer, so the write waits for the agent to read it.
  if (opts.message && agent === "claude") {
    writeFifoSoon(fifo, claudeUserLine(opts.message)).catch((err: Error) => console.error(`agent-dash: could not send the first message to ${sessionId}: ${err.message}`));
  }
  return sessionId;
}

/**
 * OpenCode runs the session in its background service, so there is no process, FIFO or log here:
 * one API call makes the session, one sends the message, and the status poller follows it.
 */
function startOpencode(sessionId: string, opts: ConversationOptions): string {
  startOpencodeStatus(config.statusDir, config.opencodeDb);
  running.add(sessionId);
  (async () => {
    if (!opts.resume) await opencodeCreate({ sessionId, cwd: opts.cwd, title: opts.name, permissions: opts.askBeforeChanges ? ASK_BEFORE_CHANGES : undefined });
    if (opts.message) {
      await opencodeSend(sessionId, opts.message);
      markOpencodeWorking(config.statusDir, sessionId, opts.cwd);
    }
  })()
    .catch((err: Error) => {
      console.error(`agent-dash: could not start OpenCode session ${sessionId}: ${err.message}`);
      opts.onSpawnError?.();
    })
    .finally(() => running.delete(sessionId));
  return sessionId;
}

/** End a headless run. A pi or Claude Code process exits; an OpenCode session stops and closes, and can resume. */
export function endHeadless(s: ReportedStatus): Promise<void> {
  // Throws at once when the process is gone, as process.kill does.
  if (s.agent !== "opencode") return Promise.resolve(void process.kill(s.pid, "SIGTERM"));
  // Never kill the pid: it is the service's, which runs every OpenCode session. A running turn
  // stops first, or the next poll would open the session again.
  return (s.state === "working" ? opencodeInterrupt(s.sessionId).catch(() => {}) : Promise.resolve()).then(() => closeOpencodeStatus(config.statusDir, s.sessionId));
}
