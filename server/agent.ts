import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentKind } from "../shared/team.ts";

/**
 * The command lines that differ between pi and Claude Code. Everything else in the dash reads
 * the same status files and, through `asPiLog`, the same session log shape for both.
 */

const CLAUDE_HOOK = new URL("../extension/claude-status-hook.ts", import.meta.url).pathname;
export const CLAUDE_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd"];

/** Single-quote a value for a POSIX shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The hook command for one event. The node that runs the dash can run its .ts files. */
export const claudeHookCommand = (event: string): string => `${shellQuote(process.execPath)} ${shellQuote(CLAUDE_HOOK)} ${event}`;

const claudeHooks = () => Object.fromEntries(CLAUDE_HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: "command", command: claudeHookCommand(e) }] }]]));

/** The status hooks, as `--settings` takes them, so a session that the dash starts reports without an install. */
export function claudeHookSettings(): string {
  return JSON.stringify({ hooks: claudeHooks() });
}

export const claudeSettingsFile = (): string => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");

/** Every Claude Code session runs the status hooks, also one that the dash did not start. */
export function claudeHooksInstalled(file = claudeSettingsFile()): boolean {
  try {
    return readFileSync(file, "utf8").includes(CLAUDE_HOOK);
  } catch {
    return false;
  }
}

/** Hooks in both places would run twice per event, so an installed set wins. */
const hookFlag = (): string[] => (claudeHooksInstalled() ? [] : ["--settings", claudeHookSettings()]);

/** Add the status hooks to the user's Claude Code settings, next to the hooks that are there. */
export function installClaudeHooks(file = claudeSettingsFile()): string {
  if (claudeHooksInstalled(file)) return `Already installed in ${file}`;
  const settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, unknown[]> }) : {};
  settings.hooks ??= {};
  for (const [event, entries] of Object.entries(claudeHooks())) settings.hooks[event] = [...(settings.hooks[event] ?? []), ...entries];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return `Installed the agent-dash status hooks in ${file}. New Claude Code sessions run them.`;
}

const PI_EXTENSION = new URL("../extension/agent-dash-status.ts", import.meta.url).pathname;
export const piExtensionFile = (): string => join(process.env.PI_EXTENSIONS_DIR ?? join(homedir(), ".pi/agent/extensions"), "agent-dash-status.ts");

/**
 * Link the status extension into pi's global extension folder. A symlink, not a copy, so a
 * `git pull` here also updates it. A headless pi gets its first message through the extension.
 */
export function installPiExtension(force = false, target = piExtensionFile()): string {
  mkdirSync(dirname(target), { recursive: true });
  if (lstatSync(target, { throwIfNoEntry: false })) {
    if (lstatSync(target).isSymbolicLink() && readlinkSync(target) === PI_EXTENSION) return `Already installed: ${target} -> ${PI_EXTENSION}`;
    if (!force) throw new Error(`${target} exists and is not agent-dash's symlink. Run \`pnpm install-extension --force\` to replace it.`);
    unlinkSync(target);
  }
  symlinkSync(PI_EXTENSION, target);
  return `Installed: ${target} -> ${PI_EXTENSION}\nNew pi sessions load it at once. In a running session, type /reload.`;
}

/** The `pi` shell alias sets this; a spawned pi does not get the alias. */
export const agentEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({ ...env, SSL_CERT_FILE: env.SSL_CERT_FILE ?? "/etc/ssl/cert.pem" });

export interface HeadlessOptions {
  name?: string;
  /** Continue this session. pi needs its file; Claude Code finds it by id in the run's folder. */
  resume?: { sessionId: string; sessionFile: string };
  /** Claude Code tools that run without a permission dialog. pi asks before no tool call. */
  allowedTools?: string[];
}

/**
 * A headless run whose stdin is a FIFO and whose only UI is the dash page. pi runs in rpc mode,
 * and its extension reads replies from the inbox. Claude Code reads stream-json messages, Stop
 * and permission answers on stdin.
 */
export function headlessCommand(agent: AgentKind, sessionId: string, opts: HeadlessOptions): { cmd: string; args: string[] } {
  if (agent === "pi") {
    const args = ["--mode", "rpc", ...(opts.resume ? ["--session", opts.resume.sessionFile] : ["--session-id", sessionId])];
    if (opts.name && !opts.resume) args.push("--name", opts.name);
    return { cmd: "pi", args };
  }
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", ...hookFlag()];
  args.push(...(opts.resume ? ["--resume", opts.resume.sessionId] : ["--session-id", sessionId]));
  if (opts.name && !opts.resume) args.push("--name", opts.name);
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  return { cmd: "claude", args };
}

/** One message to a headless Claude Code, as a stream-json line. */
export const claudeUserLine = (text: string): string => JSON.stringify({ type: "user", message: { role: "user", content: text } });
/** Stop the current turn, as Esc does. The process stays up for the next message. */
export const claudeInterruptLine = (): string => JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });

/** The default cheap model of a one-turn draft. */
export const draftModel = (agent: AgentKind): string => process.env.AGENT_DASH_DRAFT_MODEL ?? (agent === "pi" ? "anthropic/claude-haiku-4-5" : "haiku");

/** One turn with no tools, no session log and no extras: for a short draft from a prompt. */
export function draftCommand(agent: AgentKind, prompt: string): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const model = draftModel(agent);
  if (agent === "pi") {
    return { cmd: "pi", args: ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--model", model, "--thinking", "off", prompt], env: agentEnv() };
  }
  // `--tools` takes many values, so `--` keeps the prompt from reading as one.
  return { cmd: "claude", args: ["-p", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--model", model, "--", prompt], env: { ...agentEnv(), AGENT_DASH_NO_STATUS: "1" } };
}

/** A ticket summary run: read and bash only, and its session stays off the board. */
export function summaryCommand(agent: AgentKind, prompt: string, opts: { name: string; sessionDir: string }): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const model = process.env.AGENT_DASH_SUMMARY_MODEL;
  if (agent === "pi") {
    const args = ["-p", "--no-extensions", "--tools", "read,bash", "--session-dir", opts.sessionDir, "--name", opts.name];
    if (model) args.push("--model", model);
    if (process.env.AGENT_DASH_SUMMARY_THINKING) args.push("--thinking", process.env.AGENT_DASH_SUMMARY_THINKING);
    return { cmd: "pi", args: [...args, prompt], env: agentEnv() };
  }
  // pi asks before no tool call; a -p run has no one to ask, so the two tools are allowed up front.
  const args = ["-p", "--no-session-persistence", "--tools", "Read,Bash", "--allowedTools", "Read,Bash"];
  if (model) args.push("--model", model);
  return { cmd: "claude", args: [...args, "--", prompt], env: { ...agentEnv(), AGENT_DASH_NO_STATUS: "1" } };
}

/**
 * The command that a new iTerm tab runs: the agent in `dir`, named, with the context file and the
 * first message. pi attaches the context file; Claude Code gets it inline, as a headless run does.
 */
export function terminalCommand(agent: AgentKind, dir: string, name: string, contextFile: string, messageFile: string, sessionId: string): string {
  const cd = `cd ${shellQuote(dir)} && `;
  if (agent === "pi") return `${cd}pi --session-id ${shellQuote(sessionId)} --name ${shellQuote(name)} @${shellQuote(contextFile)} "$(cat ${shellQuote(messageFile)})"`;
  const hooks = hookFlag().map(shellQuote).join(" ");
  return `${cd}claude --session-id ${shellQuote(sessionId)} --name ${shellQuote(name)}${hooks ? ` ${hooks}` : ""} "$(cat ${shellQuote(contextFile)}; printf '\\n\\n'; cat ${shellQuote(messageFile)})"`;
}
