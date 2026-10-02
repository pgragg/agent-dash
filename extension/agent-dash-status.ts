/**
 * Report this pi session's status to agent-dash.
 *
 * The session log cannot tell "the agent is waiting for you" from "the tab was closed",
 * because both end with a finished assistant turn. This extension writes one small file
 * per session, so the dashboard knows which runs are live and which wait for input.
 *
 * File: ~/.agent-dash/status/<sessionId>.json (override with AGENT_DASH_STATUS_DIR).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type State = "working" | "awaiting_input" | "closed";

const DIR = process.env.AGENT_DASH_STATUS_DIR ?? join(homedir(), ".agent-dash/status");

/** iTerm2 sets ITERM_SESSION_ID to "w0t3p0:<uuid>"; the uuid lets the dashboard focus this tab. */
const ITERM_SESSION = process.env.ITERM_SESSION_ID?.split(":")[1] ?? null;

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
  pi.on("session_start", async (_event, ctx) => write(ctx, "awaiting_input"));
  pi.on("agent_start", async (_event, ctx) => write(ctx, "working"));
  // agent_end can be followed by an auto-retry or a queued message; agent_settled cannot.
  pi.on("agent_settled", async (_event, ctx) => write(ctx, "awaiting_input"));
  pi.on("session_shutdown", async (_event, ctx) => write(ctx, "closed"));
}
