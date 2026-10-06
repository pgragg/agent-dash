import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentKind } from "../../shared/team.ts";
import type { RunStatus, Turn } from "../../shared/types.ts";
import { type Found, findInReply, findInWrite } from "../diagrams.ts";
import { stripHandoff } from "../handoff.ts";

/** Everything the log says about one agent session. Status is decided later, in status.ts. */
export interface ParsedSession {
  /** The agent that wrote the log. */
  agent: AgentKind;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  name: string | null;
  firstPrompt: string;
  lastReply: string;
  /** The whole latest reply, up to LAST_MESSAGE_MAX characters (the end is kept). */
  lastMessage: string;
  askedQuestion: boolean;
  startedAt: string;
  lastActivityAt: string;
  model: string | null;
  /** How the latest assistant message ended. null while a tool call is pending or before any reply. */
  lastStopReason: string | null;
  /** The last message is not a finished assistant turn, so the agent was mid-run when the log stopped. */
  midRun: boolean;
  tickets: string[];
  createdPrs: string[];
  mentionedPrs: string[];
  userMessageCount: number;
  /** Diagrams the agent made in this session, oldest first. */
  diagrams?: Found[];
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/**
 * Ticket weights by where the key appears. The user's own words and the session name say
 * what the run is about. Tool results are ignored: one `board` call lists every open ticket.
 */
const WEIGHT = { name: 5, user: 3, toolCall: 1, assistant: 1 } as const;
/**
 * Most that one source can add to a key over a whole session. Without a cap, a long session
 * that keeps naming a ticket in passing (a status report, a board review) links to it.
 */
const CAP: Partial<Record<keyof typeof WEIGHT, number>> = { assistant: 1 };
const MAX_TICKETS = 3;
/**
 * Skills that report across all recent work. They name every ticket in sight, so nothing after
 * one starts links the session: otherwise it shows up on every ticket it listed.
 */
const REPORT_SKILLS = ["daily-progress-report", "standup-daily-summary", "itemize-invoice", "pi-usage-report", "pi-usage-invoice"];
// pi's `/skill:x` puts `<skill name="x"` in the user message, and Claude Code's `/x` puts
// `<command-name>/x</command-name>`. An agent that picks the skill reads its SKILL.md, or calls Skill.
const REPORT_SKILL_INVOKED = new RegExp(`<skill name="(?:${REPORT_SKILLS.join("|")})"|<command-name>/(?:${REPORT_SKILLS.join("|")})</command-name>`);
const REPORT_SKILL_READ = new RegExp(`/skills/(?:${REPORT_SKILLS.join("|")})/SKILL\\.md`);
const LAST_MESSAGE_MAX = 6_000;

const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g;

/**
 * The part of a tool call that says what the agent acts on. A key inside file content (a
 * write, an edit, a heredoc) is part of the repo, such as sample data in a test, not the run's ticket.
 */
export function toolCallIntent(name: string | undefined, args: unknown): string {
  const a = (args ?? {}) as { path?: unknown; command?: unknown };
  if (name === "write" || name === "edit") return String(a.path ?? "");
  if (name === "bash") return String(a.command ?? "").replace(HEREDOC, "");
  return JSON.stringify(a);
}

interface ContentPart {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentPart[])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/[*_`#>|]/g, "").trim())
    .filter(Boolean);
}

export function extractTickets(text: string, pattern: RegExp): string[] {
  return [...new Set((text.match(new RegExp(pattern.source, "gi")) ?? []).map((k) => k.toUpperCase()))];
}

/** Keep the strongest keys. A key mentioned once in passing does not link the run. */
export function pickTickets(scores: Map<string, number>): string[] {
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] ?? 0;
  return ranked
    .filter(([, score]) => score >= WEIGHT.user && score >= top / 3)
    .slice(0, MAX_TICKETS)
    .map(([key]) => key);
}

/** Claude Code's tool names and stop reasons, as pi has them, so one parser reads both logs. */
const CLAUDE_TOOLS: Record<string, string> = { Bash: "bash", Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit", Grep: "grep", Glob: "find", LS: "ls" };
const CLAUDE_STOPS: Record<string, string> = { end_turn: "stop", tool_use: "toolUse", max_tokens: "length", stop_sequence: "stop" };
const INTERRUPTED = "[Request interrupted by user";

/**
 * A Claude Code transcript in pi's log shape: a session header, the name, and one message per
 * prompt, reply and tool result. Claude Code writes each block of a reply as its own line with
 * the same message id; they become one message. A pi log comes back as it is.
 */
export function asPiLog(raw: string): { agent: AgentKind; raw: string } {
  // pi's first line is its session header; Claude Code has none.
  if (raw.startsWith('{"type":"session"')) return { agent: "pi", raw };
  const out: unknown[] = [];
  let header = false;
  let reply: { id: string; message: { content: unknown[]; stopReason: string | null } } | null = null;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // A subagent's turns are not the conversation.
    if (e.isSidechain) continue;
    if (e.type === "custom-title" && typeof e.customTitle === "string") out.push({ type: "session_info", name: e.customTitle });
    if (e.type !== "user" && e.type !== "assistant") continue;
    if (!header && e.sessionId) {
      out.push({ type: "session", id: e.sessionId, cwd: e.cwd ?? "", timestamp: e.timestamp });
      header = true;
    }
    const msg = e.message ?? {};
    const parts: any[] = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
    if (e.type === "assistant") {
      const content: unknown[] = parts.flatMap((p): unknown[] =>
        p?.type === "text" ? [{ type: "text", text: p.text }] : p?.type === "tool_use" ? [{ type: "toolCall", id: p.id, name: CLAUDE_TOOLS[p.name] ?? p.name, arguments: { ...p.input, ...(p.input?.file_path ? { path: p.input.file_path } : {}) } }] : [],
      );
      const stopReason = CLAUDE_STOPS[msg.stop_reason] ?? msg.stop_reason ?? null;
      if (reply && reply.id === msg.id) {
        reply.message.content.push(...content);
        reply.message.stopReason = stopReason;
        continue;
      }
      reply = { id: msg.id, message: { content, stopReason } };
      out.push({ type: "message", timestamp: e.timestamp, message: { role: "assistant", model: msg.model, ...reply.message } });
      continue;
    }
    reply = null;
    if (e.isMeta) continue;
    for (const p of parts) if (p?.type === "tool_result") out.push({ type: "message", timestamp: e.timestamp, message: { role: "toolResult", toolCallId: p.tool_use_id, content: p.content, isError: !!p.is_error } });
    const texts = parts.filter((p) => p?.type === "text" && typeof p.text === "string");
    if (!texts.length) continue;
    // Esc writes this as a user line; pi logs the stop on the reply instead.
    if (texts[0].text.startsWith(INTERRUPTED)) out.push({ type: "message", timestamp: e.timestamp, message: { role: "assistant", content: [], stopReason: "aborted" } });
    else out.push({ type: "message", timestamp: e.timestamp, message: { role: "user", content: texts } });
  }
  return { agent: "claude", raw: out.map((o) => JSON.stringify(o)).join("\n") };
}

export function parseSession(log: string, sessionFile: string, mtime: Date, ticketPattern: RegExp): ParsedSession | null {
  const { agent, raw } = asPiLog(log);
  let header: { id?: string; cwd?: string; timestamp?: string } | null = null;
  let name: string | null = null;
  let firstPrompt = "";
  let lastReplyText = "";
  let model: string | null = null;
  let lastStopReason: string | null = null;
  let midRun = false;
  let userMessageCount = 0;
  let usedReportSkill = false;
  const scores = new Map<string, number>();
  const created = new Set<string>();
  const mentioned = new Set<string>();
  const prCreateCalls = new Set<string>();
  let diagrams: Found[] = [];

  const added = new Map<string, number>();
  const score = (text: string, source: keyof typeof WEIGHT) => {
    // Work before the report still counts, and so does a session name, which is set on purpose.
    if (usedReportSkill && source !== "name") return;
    for (const key of extractTickets(text, ticketPattern)) {
      const sofar = added.get(`${source}:${key}`) ?? 0;
      const add = Math.min(WEIGHT[source], (CAP[source] ?? Infinity) - sofar);
      if (add <= 0) continue;
      added.set(`${source}:${key}`, sofar + add);
      scores.set(key, (scores.get(key) ?? 0) + add);
    }
  };
  const mention = (text: string) => {
    for (const url of text.match(PR_URL) ?? []) mentioned.add(url);
  };

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // A line that pi is still writing.
    }
    if (entry.type === "session") header = entry;
    else if (entry.type === "session_info") name = entry.name ?? null;
    else if (entry.type === "model_change") model = entry.modelId ?? model;
    else if (entry.type === "message") {
      const msg = entry.message ?? {};
      if (msg.role === "user") {
        // A dash handoff lists other tickets and PRs as background; count only the ticket it is for.
        const text = stripHandoff(textOf(msg.content));
        if (REPORT_SKILL_INVOKED.test(text)) usedReportSkill = true;
        userMessageCount += 1;
        if (!firstPrompt) firstPrompt = oneLine(text, 400);
        score(text, "user");
        mention(text);
        midRun = true;
      } else if (msg.role === "assistant") {
        model = msg.model ?? model;
        const text = textOf(msg.content);
        if (text.trim()) lastReplyText = text;
        if (text.includes("```") || text.includes("![")) diagrams.push(...findInReply(text, header?.cwd ?? "", entry.timestamp ?? null));
        score(text, "assistant");
        mention(text);
        for (const part of (msg.content ?? []) as ContentPart[]) {
          if (part?.type !== "toolCall") continue;
          const args = JSON.stringify(part.arguments ?? {});
          if (part.name === "read" && REPORT_SKILL_READ.test(args)) usedReportSkill = true;
          if (part.name === "Skill" && REPORT_SKILLS.includes(String((part.arguments as { skill?: unknown } | undefined)?.skill))) usedReportSkill = true;
          score(toolCallIntent(part.name, part.arguments), "toolCall");
          mention(args);
          if (part.name === "bash" && args.includes("gh pr create") && part.id) prCreateCalls.add(part.id);
          if (part.name === "write") {
            // Only the newest write of a file is current; edits are not tracked, so an older write can be stale.
            const path = (part.arguments as { path?: unknown } | undefined)?.path;
            diagrams = diagrams.filter((d) => d.origin === "reply" || d.origin !== path);
            diagrams.push(...findInWrite(part.arguments, entry.timestamp ?? null));
          }
        }
        // An abort during a tool call is logged as an error; it is a stop, not an API failure.
        lastStopReason = msg.stopReason === "error" && msg.errorMessage === "This operation was aborted" ? "aborted" : (msg.stopReason ?? null);
        midRun = msg.stopReason === "toolUse";
      } else if (msg.role === "toolResult") {
        if (prCreateCalls.has(msg.toolCallId) && !msg.isError) {
          for (const url of textOf(msg.content).match(PR_URL) ?? []) created.add(url);
        }
        midRun = true;
      }
    }
  }

  if (!header?.id) return null;
  if (name) score(name, "name");

  const replyLines = nonEmptyLines(lastReplyText);
  return {
    agent,
    sessionId: header.id,
    sessionFile,
    cwd: header.cwd ?? "",
    name,
    firstPrompt,
    lastReply: oneLine(replyLines.at(-1) ?? "", 240),
    lastMessage: lastReplyText.length > LAST_MESSAGE_MAX ? `…${lastReplyText.slice(-LAST_MESSAGE_MAX)}` : lastReplyText.trim(),
    askedQuestion: replyLines.slice(-3).some((l) => l.endsWith("?")),
    startedAt: header.timestamp ?? mtime.toISOString(),
    lastActivityAt: mtime.toISOString(),
    model,
    lastStopReason,
    midRun,
    tickets: pickTickets(scores),
    createdPrs: [...created],
    mentionedPrs: [...mentioned],
    userMessageCount,
    diagrams,
  };
}

/** Longest turn in a transcript. A pasted log or a long skill file would bury the chat. */
const TURN_MAX = 20_000;

/** Your prompts and the agent's replies, in order, without tool traffic. */
export function transcriptTurns(log: string, maxTurnChars = TURN_MAX): Turn[] {
  const turns: Turn[] = [];
  for (const line of asPiLog(log).raw.split("\n")) {
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = stripHandoff(textOf(entry.message.content)).trim();
    if (!text) continue;
    turns.push({ role, text: text.length > maxTurnChars ? `${text.slice(0, maxTurnChars)}\n\n[…cut…]` : text, at: entry.timestamp ?? null });
  }
  return turns;
}

/**
 * The conversation without tool traffic: your prompts and the agent's replies, newest kept
 * when it is too long. A summary agent reads this instead of a multi-megabyte log.
 */
export function digestSession(raw: string, maxChars: number): string {
  const turns = transcriptTurns(raw, Infinity).map((t) => `${t.role === "user" ? "USER" : "AGENT"} (${t.at ?? "?"}): ${t.text}`);
  let out = turns.join("\n\n");
  if (out.length > maxChars) out = `[…earlier turns cut…]\n${out.slice(out.length - maxChars)}`;
  return out;
}

/**
 * Status from the log alone, for sessions that the extension does not report on.
 * The log cannot say whether the pi process is still open, so time decides.
 */
export function heuristicStatus(s: ParsedSession, now: number, folderExists: (dir: string) => boolean = () => true): { status: RunStatus; since: string } {
  // No pi can run in a folder that is gone, such as a test run's temp folder.
  if (!folderExists(s.cwd)) return { status: "finished", since: s.lastActivityAt };
  const idleMs = now - Date.parse(s.lastActivityAt);
  if (s.midRun) {
    // A tool call that has written nothing for this long was killed with its session.
    return { status: idleMs < 10 * 60_000 ? "working" : "finished", since: s.lastActivityAt };
  }
  if (s.lastStopReason === null) return { status: "finished", since: s.lastActivityAt };
  return { status: idleMs < 4 * 3600_000 ? "awaiting_input" : "finished", since: s.lastActivityAt };
}

/** Re-parses only the files whose size or mtime changed since the last scan. */
export class SessionIndex {
  private cache = new Map<string, { size: number; mtimeMs: number; parsed: ParsedSession | null }>();
  private readonly dir: string;
  private readonly ticketPattern: RegExp;
  /** Sessions in another agent's folder, by id, with their log file once it is found. */
  private readonly followed = new Map<string, { dir: string; file?: string }>();

  constructor(dir: string, ticketPattern: RegExp) {
    this.dir = dir;
    this.ticketPattern = ticketPattern;
  }

  async scan(): Promise<ParsedSession[]> {
    const files: string[] = [];
    for (const project of await readdir(this.dir, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const f of await readdir(join(this.dir, project.name))) {
        if (f.endsWith(".jsonl")) files.push(join(this.dir, project.name, f));
      }
    }
    files.push(...(await this.followedFiles()));
    const seen = new Set(files);
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);

    await Promise.all(
      files.map(async (file) => {
        const st = await stat(file);
        const hit = this.cache.get(file);
        if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return;
        const parsed = parseSession(await readFile(file, "utf8"), file, st.mtime, this.ticketPattern);
        this.cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, parsed });
      }),
    );
    return [...this.cache.values()].flatMap((v) => (v.parsed ? [v.parsed] : []));
  }

  /**
   * Also read one session from another agent's log folder. The setup agent can run with the agent
   * that the user picked before a restart makes it the board's agent.
   */
  follow(dir: string, sessionId: string): void {
    if (dir !== this.dir) this.followed.set(sessionId, { dir });
  }

  private async followedFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const [id, f] of this.followed) {
      // pi names a log `<time>_<id>.jsonl`, Claude Code `<id>.jsonl`, each in a folder per project.
      if (!f.file) {
        for (const project of await readdir(f.dir, { withFileTypes: true }).catch(() => [])) {
          if (!project.isDirectory()) continue;
          const name = (await readdir(join(f.dir, project.name)).catch(() => [])).find((n) => n === `${id}.jsonl` || n.endsWith(`_${id}.jsonl`));
          if (name) f.file = join(f.dir, project.name, name);
        }
      }
      if (f.file && existsSync(f.file)) out.push(f.file);
    }
    return out;
  }

  /** A session from the last scan, without a new scan: the dashboard scans often enough. */
  peek(sessionId: string): ParsedSession | null {
    for (const v of this.cache.values()) if (v.parsed?.sessionId === sessionId) return v.parsed;
    return null;
  }

  /** The log file of a session seen by the last scan. The page names a session by id, never by path. */
  fileFor(sessionId: string): string | null {
    for (const [file, v] of this.cache) if (v.parsed?.sessionId === sessionId) return file;
    return null;
  }
}
