/**
 * Report this pi session's status to agent-dash.
 *
 * The session log cannot tell "the agent is waiting for you" from "the tab was closed",
 * because both end with a finished assistant turn. This extension writes one small file
 * per session, so the dashboard knows which runs are live and which wait for input.
 *
 * File: ~/.agent-dash/status/<sessionId>.json (override with AGENT_DASH_STATUS_DIR).
 * It also holds the tool that runs now, and the extension dialog that is open, if any.
 *
 * It also delivers what you send from the dashboard. The dashboard drops one file per message
 * into ~/.agent-dash/inbox/<sessionId>/, and this extension acts on it, then deletes it:
 * - <n>.txt   a reply. While the agent works, it waits until the agent finishes.
 * - <n>.steer a reply that goes in after the current tool calls, before the next model call.
 * - <n>.abort stop the current agent run, as Esc does.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FSWatcher, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type State = "working" | "awaiting_input" | "closed";

/** What the status file says about the extension. The dash shows Stop and Steer from version 2. */
const VERSION = 2;

const DIR = process.env.AGENT_DASH_STATUS_DIR ?? join(homedir(), ".agent-dash/status");
const INBOX = process.env.AGENT_DASH_INBOX_DIR ?? join(homedir(), ".agent-dash/inbox");

/** A tool-heavy run must not rewrite the status file (and reload the dash) many times a second. */
const ACTIVITY_WRITE_MS = 1_500;

/** iTerm2 sets ITERM_SESSION_ID to "w0t3p0:<uuid>"; the uuid lets the dashboard focus this tab. */
const ITERM_SESSION = process.env.ITERM_SESSION_ID?.split(":")[1] ?? null;

interface Activity {
  tool: string;
  summary: string;
  since: string;
}

interface Dialog {
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  since: string;
}

/** A session you sit at (tui) or one the dash runs headless (rpc); a `pi -p` run has no one to reply for. */
function takesReplies(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * One short line about a tool call. The page shows it to anyone at the screen, so values
 * that look like secrets are hidden, and file contents never leave the arguments.
 */
export function summarizeTool(toolName: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  let text = "";
  if (toolName === "bash") text = str(a.command);
  else if (["read", "edit", "write", "ls"].includes(toolName)) text = str(a.path) || str(a.file_path);
  else if (toolName === "grep" || toolName === "find") text = str(a.pattern);
  text = text
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]+/gi, "$1 ***")
    .replace(/((?:token|secret|password|passwd|api[_-]?key|auth)[\w-]*["']?\s*[=:]\s*["']?)[^\s"'&]+/gi, "$1***")
    .replace(/(--?(?:token|password|secret|api-key)[= ])\S+/gi, "$1***");
  return cut(text, 80);
}

export default function (pi: ExtensionAPI) {
  let current: ExtensionContext | null = null;
  let watcher: FSWatcher | null = null;
  let state: State = "awaiting_input";
  let since = new Date().toISOString();
  // Parallel tools can overlap; the newest one that still runs is the one to show.
  const running = new Map<string, Activity>();
  const dialogs: Dialog[] = [];
  let lastWrite = 0;
  let timer: NodeJS.Timeout | null = null;

  const write = (ctx: ExtensionContext | null = current) => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastWrite = Date.now();
    const sessionId = ctx?.sessionManager.getSessionId();
    if (!ctx || !sessionId) return;
    const file = join(DIR, `${sessionId}.json`);
    const body = {
      sessionId,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      cwd: ctx.cwd,
      pid: process.pid,
      itermSessionId: ITERM_SESSION,
      inbox: takesReplies(ctx),
      version: VERSION,
      // An rpc session has no terminal; the dash page is the only way to talk to it.
      mode: ctx.mode,
      state,
      since,
      activity: state === "working" ? ([...running.values()].at(-1) ?? null) : null,
      dialog: state === "closed" ? null : (dialogs.at(-1) ?? null),
    };
    try {
      mkdirSync(DIR, { recursive: true });
      // Rename is atomic, so the dashboard never reads half a file.
      writeFileSync(`${file}.tmp`, JSON.stringify(body));
      renameSync(`${file}.tmp`, file);
    } catch {
      // A status file is not worth breaking the session for.
    }
  };

  const setState = (ctx: ExtensionContext, next: State) => {
    current = next === "closed" ? null : ctx;
    state = next;
    since = new Date().toISOString();
    running.clear();
    write(ctx);
  };

  /** Write at most once per ACTIVITY_WRITE_MS, and always write the last change. */
  const writeSoon = () => {
    if (timer) return;
    const wait = lastWrite + ACTIVITY_WRITE_MS - Date.now();
    if (wait <= 0) return write();
    timer = setTimeout(() => write(), wait);
    timer.unref();
  };

  /**
   * pi has no event for a dialog, so wrap the dialog methods of the shared UI object. Every
   * extension's ctx.ui is that object, so a dialog from any extension shows on the dash.
   */
  const HOOK = Symbol.for("agent-dash.dialog-hook");
  const watchDialogs = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    try {
      const ui = ctx.ui as unknown as Record<string | symbol, unknown>;
      // A /reload loads this file again; the new copy replaces the hook and keeps one wrapper.
      const firstTime = !ui[HOOK];
      ui[HOOK] = (open: boolean, d: Dialog) => {
        const i = dialogs.lastIndexOf(d);
        if (open) dialogs.push(d);
        // A dialog that opened before a /reload belongs to the old copy's list.
        else if (i >= 0) dialogs.splice(i, 1);
        write();
      };
      if (!firstTime) return;
      for (const method of ["select", "confirm", "input", "editor"] as const) {
        const original = ui[method];
        if (typeof original !== "function") continue;
        ui[method] = async function (this: unknown, title: string, second?: unknown, ...rest: unknown[]) {
          const d: Dialog = { method, title: cut(String(title ?? ""), 200), since: new Date().toISOString() };
          if (method === "select" && Array.isArray(second)) d.options = second.slice(0, 30).map((o) => cut(String(o), 200));
          if (method === "confirm" && typeof second === "string") d.message = cut(second, 1000);
          if (method === "input" && typeof second === "string") d.placeholder = cut(second, 200);
          if (method === "editor" && typeof second === "string") d.prefill = second.slice(0, 4000);
          const hook = (open: boolean) => {
            try {
              (ui[HOOK] as (open: boolean, d: Dialog) => void)(open, d);
            } catch {
              // The dialog itself must still open and close.
            }
          };
          hook(true);
          try {
            return await (original as (...a: unknown[]) => Promise<unknown>).call(this, title, second, ...rest);
          } finally {
            hook(false);
          }
        };
      }
    } catch {
      // Without the wrapper, dialogs still work; the dash just does not see them.
    }
  };

  const deliver = (dir: string) => {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => /\.(txt|steer|abort)$/.test(f)).sort();
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
      if (f.endsWith(".abort")) {
        if (current && !current.isIdle()) current.abort();
        continue;
      }
      if (!text) continue;
      if (current?.isIdle()) pi.sendUserMessage(text);
      // A plain reply waits until the agent finishes, as typing in the tab would.
      else pi.sendUserMessage(text, { deliverAs: f.endsWith(".steer") ? "steer" : "followUp" });
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
    watchDialogs(ctx);
    watchInbox(ctx);
    setState(ctx, "awaiting_input");
  });
  pi.on("agent_start", async (_event, ctx) => {
    setState(ctx, "working");
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    current = ctx;
    running.delete(event.toolCallId);
    running.set(event.toolCallId, { tool: event.toolName, summary: summarizeTool(event.toolName, event.args), since: new Date().toISOString() });
    writeSoon();
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    current = ctx;
    running.delete(event.toolCallId);
    writeSoon();
  });
  // agent_end can be followed by an auto-retry or a queued message; agent_settled cannot.
  pi.on("agent_settled", async (_event, ctx) => {
    setState(ctx, "awaiting_input");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    watcher?.close();
    watcher = null;
    dialogs.length = 0;
    setState(ctx, "closed");
  });
}
