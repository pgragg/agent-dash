/**
 * Report this pi session's status to agent-dash.
 *
 * The session log cannot tell "the agent is waiting for you" from "the tab was closed",
 * because both end with a finished assistant turn. This extension writes one small file
 * per session, so the dashboard knows which runs are live and which wait for input.
 *
 * File: ~/.agent-dash/status/<sessionId>.json (override with AGENT_DASH_STATUS_DIR).
 *
 * It also delivers replies that you type in the dashboard: the dashboard drops one *.txt
 * file per reply into ~/.agent-dash/inbox/<sessionId>/, and this extension sends each one to
 * the agent as your message, then deletes it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FSWatcher, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type State = "working" | "awaiting_input" | "closed";

const DIR = process.env.AGENT_DASH_STATUS_DIR ?? join(homedir(), ".agent-dash/status");
const INBOX = process.env.AGENT_DASH_INBOX_DIR ?? join(homedir(), ".agent-dash/inbox");

/** iTerm2 sets ITERM_SESSION_ID to "w0t3p0:<uuid>"; the uuid lets the dashboard focus this tab. */
const ITERM_SESSION = process.env.ITERM_SESSION_ID?.split(":")[1] ?? null;

/** A session you sit at (tui) or one the dash runs headless (rpc); a `pi -p` run has no one to reply for. */
function takesReplies(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

function write(ctx: ExtensionContext, state: State): void {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId) return;
  const file = join(DIR, `${sessionId}.json`);
  const body = {
    sessionId,
    sessionFile: ctx.sessionManager.getSessionFile() ?? null,
    cwd: ctx.cwd,
    pid: process.pid,
    itermSessionId: ITERM_SESSION,
    inbox: takesReplies(ctx),
    // An rpc session has no terminal; the dash page is the only way to talk to it.
    mode: ctx.mode,
    state,
    since: new Date().toISOString(),
  };
  try {
    mkdirSync(DIR, { recursive: true });
    // Rename is atomic, so the dashboard never reads half a file.
    writeFileSync(`${file}.tmp`, JSON.stringify(body));
    renameSync(`${file}.tmp`, file);
  } catch {
    // A status file is not worth breaking the session for.
  }
}

export default function (pi: ExtensionAPI) {
  let current: ExtensionContext | null = null;
  let watcher: FSWatcher | null = null;

  const deliver = (dir: string) => {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
    } catch {
      return;
    }
    for (const f of files) {
      let text = "";
      try {
        text = readFileSync(join(dir, f), "utf8").trim();
        unlinkSync(join(dir, f));
      } catch {
        continue; // Another watcher event already took it.
      }
      if (!text) continue;
      // While the agent works, queue the reply until it finishes, as typing in the tab would.
      if (current?.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
  };

  const watchInbox = (ctx: ExtensionContext) => {
    watcher?.close();
    watcher = null;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId || !takesReplies(ctx)) return;
    const dir = join(INBOX, sessionId);
    try {
      mkdirSync(dir, { recursive: true });
      watcher = watch(dir, () => deliver(dir));
      // An open watcher must not keep pi running after the session ends.
      watcher.unref();
      deliver(dir);
    } catch {
      // Without an inbox the session still reports status.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    current = ctx;
    watchInbox(ctx);
    write(ctx, "awaiting_input");
  });
  pi.on("agent_start", async (_event, ctx) => {
    current = ctx;
    write(ctx, "working");
  });
  // agent_end can be followed by an auto-retry or a queued message; agent_settled cannot.
  pi.on("agent_settled", async (_event, ctx) => {
    current = ctx;
    write(ctx, "awaiting_input");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    watcher?.close();
    watcher = null;
    current = null;
    write(ctx, "closed");
  });
}
