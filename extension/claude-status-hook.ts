/**
 * Report a Claude Code session's status to agent-dash, as the pi extension does for pi.
 *
 * Claude Code runs this once per hook event: `node claude-status-hook.ts <Event>`, with the
 * event's JSON on stdin. Each run reads the session's status file, changes it, and writes it
 * back: ~/.agent-dash/status/<sessionId>.json (override with AGENT_DASH_STATUS_DIR).
 *
 * agent-dash passes these hooks with `--settings` to each Claude Code that it starts. For other
 * sessions, `pnpm install-extension` adds them to ~/.claude/settings.json.
 *
 * Replies, Stop and dialog answers do not go through here: a headless run reads them on its
 * stdin, which the server writes. A terminal session takes them only in its own tab.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { permissionTitle, toolTarget } from "../shared/claudeDialog.ts";
import { summarizeTool } from "./agent-dash-status.ts";

const DIR = process.env.AGENT_DASH_STATUS_DIR ?? join(homedir(), ".agent-dash/status");

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
}

/** Claude Code runs a hook through a shell or directly; the status needs the claude pid. */
function claudePid(): number {
  try {
    const [ppid, comm] = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(process.ppid)], { encoding: "utf8" }).trim().split(/\s+/);
    return /(^|\/)-?(sh|bash|zsh|dash)$/.test(comm ?? "") ? Number(ppid) : process.ppid;
  } catch {
    return process.ppid;
  }
}

export function main(event: string, input: HookInput): void {
  // The dash's own `claude -p` runs (summaries, drafts) are not agents on the board.
  if (process.env.AGENT_DASH_NO_STATUS || !input.session_id || !/^[\w-]{8,64}$/.test(input.session_id)) return;
  const file = join(DIR, `${input.session_id}.json`);
  let old: Record<string, unknown> = {};
  try {
    old = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // The first event of the session.
  }
  const now = new Date().toISOString();
  // A headless run that the dash started reads replies on its stdin; a terminal session does not.
  const headless = process.env.AGENT_DASH_MODE === "rpc";
  const body: Record<string, unknown> = {
    ...old,
    sessionId: input.session_id,
    sessionFile: input.transcript_path ?? old.sessionFile ?? null,
    cwd: input.cwd ?? old.cwd,
    pid: claudePid(),
    itermSessionId: process.env.ITERM_SESSION_ID?.split(":")[1] ?? null,
    agent: "claude",
    inbox: headless,
    version: 2,
    mode: headless ? "rpc" : "tui",
  };
  const set = (state: string) => {
    if (old.state !== state) body.since = now;
    body.state = state;
  };
  if (event === "SessionStart") {
    set("awaiting_input");
    body.activity = null;
    body.dialog = null;
  } else if (event === "UserPromptSubmit") {
    set("working");
    body.activity = null;
  } else if (event === "PreToolUse") {
    set("working");
    const tool = input.tool_name ?? "";
    body.activity = { tool, summary: summarizeTool(tool.toLowerCase(), input.tool_input), since: now };
  } else if (event === "PostToolUse") {
    body.activity = null;
    body.dialog = null;
  } else if (event === "PermissionRequest") {
    const tool = input.tool_name ?? "";
    body.dialog = { method: "confirm", title: permissionTitle(tool, input.tool_input), message: toolTarget(input.tool_input).slice(0, 1000), since: now };
  } else if (event === "Stop") {
    set("awaiting_input");
    body.activity = null;
    body.dialog = null;
  } else if (event === "SessionEnd") {
    set("closed");
    body.activity = null;
    body.dialog = null;
  } else return;
  body.since ??= now;
  try {
    mkdirSync(DIR, { recursive: true });
    // Rename is atomic, so the dashboard never reads half a file.
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(body));
    renameSync(`${file}.${process.pid}.tmp`, file);
  } catch {
    // A status file is not worth breaking the session for.
  }
}

if (import.meta.main) {
  let input: HookInput = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // No JSON: nothing to report.
  }
  main(process.argv[2] ?? "", input);
}
