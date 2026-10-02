import type { PullRequest, Run, Ticket } from "../shared/types.ts";

export const PATTERN = /\b(?:FSDK|EFSUP)-\d+\b/g;
export const NOW = Date.parse("2026-10-02T12:00:00Z");
export const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

type Entry = Record<string, unknown>;

export const header = (id = "s1", cwd = "/repo"): Entry => ({ type: "session", version: 3, id, timestamp: minutesAgo(60), cwd });
export const user = (text: string): Entry => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
export const name = (n: string): Entry => ({ type: "session_info", name: n });
export const reply = (text: string, stopReason = "stop"): Entry => ({
  type: "message",
  message: { role: "assistant", model: "m", stopReason, content: [{ type: "text", text }] },
});
export const toolCall = (id: string, command: string): Entry => ({
  type: "message",
  message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] },
});
export const toolResult = (id: string, text: string, isError = false): Entry => ({
  type: "message",
  message: { role: "toolResult", toolCallId: id, toolName: "bash", isError, content: [{ type: "text", text }] },
});
export const jsonl = (...entries: Entry[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

export function run(over: Partial<Run> = {}): Run {
  return {
    sessionId: "s1",
    sessionFile: "/f.jsonl",
    cwd: "/repo",
    name: "A run",
    firstPrompt: "do it",
    lastReply: "",
    lastMessage: "",
    startedAt: minutesAgo(120),
    lastActivityAt: minutesAgo(5),
    model: null,
    status: "finished",
    statusSource: "extension",
    statusSince: minutesAgo(5),
    askedQuestion: false,
    endedInError: false,
    stoppedByUser: false,
    tickets: [],
    createdPrs: [],
    mentionedPrs: [],
    userMessageCount: 1,
    canReply: false,
    itermSessionId: null,
    ...over,
  };
}

export function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    url: "https://github.com/o/r/pull/1",
    repo: "o/r",
    number: 1,
    title: "fix",
    state: "open",
    isDraft: false,
    headRef: "b",
    reviewDecision: null,
    checks: "success",
    mergeable: "MERGEABLE",
    updatedAt: minutesAgo(10),
    tickets: [],
    ...over,
  };
}

export function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    key: "FSDK-1",
    url: "https://jira/browse/FSDK-1",
    summary: "t",
    status: "In Progress",
    statusCategory: "indeterminate",
    priority: "P3 - Medium",
    dueDate: null,
    updatedAt: minutesAgo(60),
    assignedToMe: true,
    ...over,
  };
}
