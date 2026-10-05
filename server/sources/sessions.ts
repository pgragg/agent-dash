import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunStatus, Turn } from "../../shared/types.ts";
import { type Found, findInReply, findInWrite } from "../diagrams.ts";
import { stripHandoff } from "../handoff.ts";

/** Everything the log says about one pi session. Status is decided later, in status.ts. */
export interface ParsedSession {
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
const LAST_MESSAGE_MAX = 6_000;

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

export function parseSession(raw: string, sessionFile: string, mtime: Date, ticketPattern: RegExp): ParsedSession | null {
  let header: { id?: string; cwd?: string; timestamp?: string } | null = null;
  let name: string | null = null;
  let firstPrompt = "";
  let lastReplyText = "";
  let model: string | null = null;
  let lastStopReason: string | null = null;
  let midRun = false;
  let userMessageCount = 0;
  const scores = new Map<string, number>();
  const created = new Set<string>();
  const mentioned = new Set<string>();
  const prCreateCalls = new Set<string>();
  const diagrams: Found[] = [];

  const added = new Map<string, number>();
  const score = (text: string, source: keyof typeof WEIGHT) => {
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
          score(args, "toolCall");
          mention(args);
          if (part.name === "bash" && args.includes("gh pr create") && part.id) prCreateCalls.add(part.id);
          if (part.name === "write") diagrams.push(...findInWrite(part.arguments, entry.timestamp ?? null));
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
export function transcriptTurns(raw: string, maxTurnChars = TURN_MAX): Turn[] {
  const turns: Turn[] = [];
  for (const line of raw.split("\n")) {
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
export function heuristicStatus(s: ParsedSession, now: number): { status: RunStatus; since: string } {
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
