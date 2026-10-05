import { progressLines, sdlcProgress } from "../shared/sdlc.ts";
import type { Note, PullRequest, Run, SdlcEvent, TicketGroup, TicketSummaryState } from "../shared/types.ts";

/**
 * The context a new agent starts with: what the ticket's page shows. It goes into the first
 * message as an attached file, between these markers. The session parser replaces the block with
 * the one ticket it was made for, so the keys and PRs inside it do not link the run to other tickets.
 */
export const HANDOFF_START = (key: string) => `[agent-dash context for ${key}]`;
export const HANDOFF_END = "[end of agent-dash context]";
/** pi wraps an attached file in <file name="…">…</file>; the wrapper goes too. */
export const HANDOFF_BLOCK = /(?:<file name="[^"]*">\s*)?\[agent-dash context for ([A-Z][A-Z0-9]*-\d+)\][\s\S]*?\[end of agent-dash context\](?:\s*<\/file>)?/g;

/** The handoff blocks in a message, replaced with the key each one was made for. */
export function stripHandoff(text: string): string {
  return text.replace(HANDOFF_BLOCK, (_m, key: string) => HANDOFF_START(key));
}

/** The first message of an agent started from one drafted next step. */
export function stepMessage(key: string, step: string): string {
  return `Do this next step on ${key}. It comes from the drafted next steps in the context, which can be out of date: check it against the newer sources there before you act.\n\n${step}`;
}

/**
 * The first message of a headless agent: the context, then your message. rpc mode takes no
 * `@file`, so the context goes inline; the markers keep its keys out of the run's tickets.
 */
export function agentMessage(context: string, message: string): string {
  return `${context}\n\n${message.trim()}`;
}

/** The session name carries the key, so the new run links to the ticket at once. */
export function agentName(key: string, text: string): string {
  return `${key}: ${text.replace(/[*`]/g, "").trim().split("\n")[0].slice(0, 60)}`;
}

export interface HandoffInput {
  group: TicketGroup;
  notes: Note[];
  summary: TicketSummaryState | undefined;
  /** The ticket's smoketests and confirmed deploys, newest first. */
  events?: SdlcEvent[];
  now: Date;
}

const MESSAGE_MAX = 4_000;

function status(run: Run): string {
  if (run.status === "awaiting_input") return "waiting for input";
  return run.status;
}

function prLine(p: PullRequest): string {
  const bits = [p.isDraft && p.state === "open" ? "draft" : p.state, p.state === "open" ? `CI ${p.checks}` : "", p.state === "open" ? (p.reviewDecision ?? "") : "", p.mergeable === "CONFLICTING" ? "merge conflict" : ""].filter(Boolean);
  return `- ${p.url} — ${p.title} (${bits.join(", ")}; updated ${p.updatedAt})`;
}

/** Live runs, plus the newest one when none is live: the same agents the page shows as cards. */
export function featuredRuns(group: TicketGroup): Run[] {
  const relevant = group.runs.filter((r) => group.threads[r.sessionId]?.status !== "resolved");
  const live = relevant.filter((r) => r.status !== "finished");
  return live.length ? live : relevant.slice(-1);
}

export function buildHandoff({ group, notes, summary, events = [], now }: HandoffInput): string {
  const t = group.ticket;
  const out: string[] = [
    HANDOFF_START(t.key),
    `Piper started this agent from agent-dash at ${now.toISOString()}, with what the dashboard knows about ${t.key}.`,
    "Treat it as background: Piper's message after this context says what to do. Notes are Piper's own and the most trusted source.",
    "",
    `# ${t.key}: ${t.summary}`,
    t.file ? `- Ticket file: ${t.file}` : `- Jira: ${t.url}`,
    `- Status: ${t.status} · Priority: ${t.priority ?? "-"} · Due: ${t.dueDate ?? "-"}`,
    "",
    "## Piper's notes (oldest first)",
    ...(notes.length ? notes.map((n) => `- [${n.createdAt}] ${n.body.replace(/\n/g, "\n  ")}`) : ["- none"]),
    "",
  ];

  const done = summary?.latest.status === "done" ? summary.latest : (summary?.lastDone ?? null);
  out.push("## Next steps (drafted by a summary agent)");
  if (done?.summary) out.push(`Drafted ${done.generatedAt ?? done.requestedAt}. It can be out of date.`, "", done.summary);
  else out.push("- none drafted yet");
  out.push("", "## Pull requests");
  out.push(...(group.prs.length ? group.prs.map(prLine) : ["- none"]));
  out.push("", "## SDLC progress (stages can be skipped)", ...progressLines(sdlcProgress({ ticket: t, prs: group.prs, events })));

  const featured = featuredRuns(group);
  if (featured.length) {
    out.push("", "## Latest message from each agent conversation that is still relevant");
    for (const r of featured) {
      const msg = r.lastMessage.length > MESSAGE_MAX ? `…${r.lastMessage.slice(-MESSAGE_MAX)}` : r.lastMessage;
      out.push("", `### ${r.name ?? r.firstPrompt.slice(0, 80)} (${status(r)}, last active ${r.lastActivityAt})`, "", msg || "(no reply yet)");
    }
  }

  out.push("", "## Agent conversation history (oldest first)");
  if (group.runs.length === 0) out.push("- none");
  for (const r of group.runs) {
    const th = group.threads[r.sessionId];
    const resolution = th?.status === "resolved" ? `resolved by Piper ${th.createdAt}${th.reason ? `: ${th.reason}` : ""}` : "relevant";
    out.push(`- ${r.name ?? r.firstPrompt.slice(0, 80)} · started ${r.startedAt} · ${r.userMessageCount} prompts · ${status(r)} · ${resolution} · log ${r.sessionFile}`);
  }
  out.push("", HANDOFF_END);
  return out.join("\n");
}
