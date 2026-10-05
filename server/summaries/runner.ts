import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mergePrs, progressLines, sdlcProgress } from "../../shared/sdlc.ts";
import type { Note, PullRequest, Run, SdlcEvent, ThreadStatusChange, Ticket } from "../../shared/types.ts";
import { config } from "../config.ts";
import { fetchTicketPrs } from "../sources/github.ts";
import { digestSession } from "../sources/sessions.ts";
import { isAlive } from "../sources/status.ts";
import * as db from "./db.ts";

/** After this, a request counts as stuck: the page offers a re-request, and the run is stopped. */
export const STALE_MS = 30 * 60_000;

const ROOT = process.env.AGENT_DASH_HOME ?? join(homedir(), ".agent-dash");
const WORK_ROOT = join(ROOT, "summaries");
/** Outside ~/.pi/agent/sessions, so summary runs do not show up as runs of the ticket. */
const SESSION_DIR = join(ROOT, "summary-sessions");
const SAVE_SCRIPT = new URL("../../scripts/save-summary.ts", import.meta.url).pathname;
const SLACK_SCRIPT = new URL("../../scripts/slack-search.ts", import.meta.url).pathname;
/** In a run's work folder: one JSON line per Slack match that the run found. */
export const SLACK_HITS = "slack.jsonl";
const CONTEXT_BUDGET = 60_000;
const PER_SESSION_MAX = 12_000;

const children = new Map<number, ChildProcess>();

export interface SummaryInput {
  ticket: Ticket;
  runs: Run[];
  prs: PullRequest[];
  notes?: Note[];
  /** Newest status change per session; a "resolved" thread is listed but not digested. */
  threads?: Record<string, ThreadStatusChange>;
  /** Smoketests and confirmed deploys, newest first. */
  events?: SdlcEvent[];
  /** PRs with the key in the title, from any author and any time. Only for the SDLC progress. */
  ticketPrs?: PullRequest[];
}

function prLine(p: PullRequest): string {
  const bits = [p.state, p.isDraft ? "draft" : "", `CI ${p.checks}`, p.reviewDecision ?? "", p.mergeable === "CONFLICTING" ? "conflict" : ""].filter(Boolean);
  return `- ${p.url} — ${p.title} (${bits.join(", ")}; updated ${p.updatedAt})`;
}

/** What agent-dash already knows, so the agent spends its time on Jira, PR comments and Slack. */
export async function buildContext({ ticket, runs: allRuns, prs, notes = [], threads = {}, events = [], ticketPrs = [] }: SummaryInput): Promise<string> {
  // Piper marked these threads as no longer relevant to the ticket; their history would mislead.
  const resolved = allRuns.filter((r) => threads[r.sessionId]?.status === "resolved");
  const runs = allRuns.filter((r) => threads[r.sessionId]?.status !== "resolved");
  const out: string[] = [
    `# ${ticket.key}: ${ticket.summary}`,
    "",
    `- Jira: ${ticket.url}`,
    `- Status: ${ticket.status} · Priority: ${ticket.priority ?? "-"} · Due: ${ticket.dueDate ?? "-"} · Updated: ${ticket.updatedAt || "-"}`,
    `- Assigned to Piper: ${ticket.assignedToMe ? "yes" : "no"}`,
    "",
    // Piper's notes come first: they hold decisions and context that no other source has.
    `## Piper's private notes on ${ticket.key} (oldest first)`,
    ...(notes.length ? notes.map((n) => `- [${n.createdAt}] ${n.body.replace(/\n/g, "\n  ")}`) : ["- none"]),
    "",
    `## PRs linked to ${ticket.key} (GitHub, updated in the last 14 days)`,
    ...(prs.length ? prs.map(prLine) : ["- none found"]),
  ];

  out.push("", `## SDLC progress of ${ticket.key} (stages can be skipped)`, ...progressLines(sdlcProgress({ ticket, prs: mergePrs(prs, ticketPrs), events })));
  const smoketests = events.filter((e) => e.eventType === "smoketest");
  if (smoketests.length) {
    out.push("", "## Smoketests (newest first)");
    for (const e of smoketests) out.push(`- ${e.startedAt} · ${e.environments.join(", ")} · ${e.outcome ?? "no outcome"}${e.testDetails ? ` · ${e.testDetails.split("\n")[0].slice(0, 160)}` : ""}`);
  }

  const known = new Set(prs.map((p) => p.url));
  const older = [...new Set(runs.flatMap((r) => r.createdPrs))].filter((u) => !known.has(u));
  if (older.length) out.push("", "## Older PRs that runs for this ticket opened", ...older.map((u) => `- ${u}`));

  // Newest sessions get the budget first; then print oldest first, as a timeline.
  const sorted = [...runs].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const digests = new Map<string, string>();
  let left = CONTEXT_BUDGET;
  for (const r of sorted) {
    if (left < 1_000) break;
    const raw = await readFile(r.sessionFile, "utf8").catch(() => "");
    const d = digestSession(raw, Math.min(PER_SESSION_MAX, left));
    digests.set(r.sessionId, d);
    left -= d.length;
  }
  if (resolved.length) {
    out.push("", `## Threads Piper marked resolved for ${ticket.key} (no longer relevant; do not plan from them)`);
    for (const r of resolved) {
      const t = threads[r.sessionId];
      out.push(`- ${r.name ?? r.firstPrompt.slice(0, 80)} (resolved ${t.createdAt}${t.reason ? `: ${t.reason}` : ""})`);
    }
  }
  out.push("", `## pi sessions about ${ticket.key} (${runs.length}, oldest first)`);
  if (runs.length === 0) out.push("", "No pi session names this ticket.");
  for (const r of [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    out.push(
      "",
      `### ${r.name ?? r.firstPrompt.slice(0, 80)}`,
      `started ${r.startedAt} · last active ${r.lastActivityAt} · status ${r.status} · cwd ${r.cwd}`,
      `log: ${r.sessionFile}`,
      "",
      digests.get(r.sessionId) ?? "(digest left out: context budget used up; read the log if needed)",
    );
  }
  return out.join("\n");
}

export function buildPrompt(key: string, id: number, workDir: string): string {
  const contextFile = join(workDir, "context.md");
  const summaryFile = join(workDir, "summary.md");
  return `Write a next-steps summary for Jira ticket ${key}. Piper oversees several coding agents at once and reads it in a dashboard, so keep it very short.

RULES
- Read-only. Do not write to Jira, GitHub, Slack, or any repo: no comments, transitions, reviews, messages, reactions, commits, or pushes.
- Spend at most 10 minutes. If a source fails, skip it and note it under "Gaps".
- Piper's private notes (in the context file) are the most trusted source: when a newer note disagrees with an older source, follow the note. They are private, so never copy them anywhere outside the summary.
- Follow the SDLC order in the context file's "SDLC progress": PR, local smoketest, in Beta, Beta smoketest, in Prod, Prod smoketest, Done. A local smoketest comes before a PR review request, and a Beta smoketest comes before the prod chart version update deploy PR. When the next stage is a smoketest, one step must say to run a smoketest and name the environment (localhost, Postman Beta, or Postman Prod). When the next stage is a blocked smoketest, one step must say what blocks it and how to remove the blocker. Piper can skip a stage: never plan a step for a stage that shows as skipped.

STEPS
1. Read ${contextFile}. agent-dash already put Piper's private notes, the ticket fields, linked PRs, and digests of the pi sessions about ${key} in it.
2. Jira body and comments:
   set -a; source ~/pi/secrets/jira/.env.personal; set +a; jira issue view ${key} --comments 20 --plain
3. For each open PR, and each PR merged in the last 7 days, read CI and review comments:
   gh pr view <url> --comments
4. Slack, read-only. Search with this script only; do not drive the Slack UI:
   node ${SLACK_SCRIPT} "${key}"
   It prints the newest matches with permalinks. If it says the login expired, skip Slack.
   When a step rests on a Slack message, put the message's full permalink in the step: the dashboard quotes the message next to the summary.

OUTPUT (at most 120 words, markdown):
**State:** one sentence.
**Next steps:**
1. The most important step first. Start each step with who acts: Piper, an agent, or a named person.
(1 to 4 steps)
**Blockers:** one line, or "none".
**Gaps:** one line, only if a source failed.

SAVE
Write the summary to ${summaryFile}, then run:
node ${SAVE_SCRIPT} ${id} < ${summaryFile}
Then reply with the summary text only.`;
}

/** pi's stdout can carry terminal title escapes; keep only the text. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * Close out a run that ended without saving. pi -p prints its last reply, which the prompt
 * asks to be the summary, so a non-empty stdout still counts as a result.
 */
export function finish(id: number, exitCode: number | null): void {
  const rec = db.get(id);
  if (!rec || rec.status !== "in_progress") return;
  const read = (f: string) => (rec.workDir && existsSync(join(rec.workDir, f)) ? readFileSync(join(rec.workDir, f), "utf8") : "");
  const text = stripAnsi(read("out.log")).trim();
  if ((exitCode === 0 || exitCode === null) && text.length > 40) {
    db.markDone(id, text);
  } else {
    const tail = stripAnsi(read("err.log")).trim().split("\n").slice(-5).join("\n");
    db.markFailed(id, `pi exited${exitCode === null ? "" : ` with code ${exitCode}`} without a summary${tail ? `: ${tail}` : ""}`);
  }
}

/** A run whose process is gone, and that this server did not see exit (it restarted). */
export function reconcile(now = Date.now()): void {
  for (const rec of db.inProgress()) {
    if (children.has(rec.id)) continue;
    if (rec.pid && isAlive(rec.pid)) continue;
    // Give a just-created row a moment to get its pid.
    if (!rec.pid && now - Date.parse(rec.requestedAt) < 60_000) continue;
    finish(rec.id, null);
  }
}

function stop(rec: db.SummaryRecord): void {
  const child = children.get(rec.id);
  if (child) child.kill("SIGTERM");
  else if (rec.pid && isAlive(rec.pid)) process.kill(rec.pid, "SIGTERM");
}

/**
 * Start a summary run, unless one for the ticket is already running and not yet stale.
 * `onChange` fires when the run ends, so the page can update.
 */
export async function requestSummary(input: SummaryInput, opts: { force?: boolean; onChange?: () => void } = {}): Promise<db.SummaryRecord> {
  const key = input.ticket.key;
  const current = db.latestForTicket(key);
  if (current?.status === "in_progress") {
    const stale = Date.now() - Date.parse(current.requestedAt) > STALE_MS;
    if (!stale && !opts.force) return current;
    stop(current);
    db.markFailed(current.id, stale ? "stuck for more than 30 minutes; replaced by a new request" : "replaced by a new request");
  }

  const rec = db.createRequest(key);
  const workDir = join(WORK_ROOT, String(rec.id));
  mkdirSync(workDir, { recursive: true });
  mkdirSync(SESSION_DIR, { recursive: true });
  // A failed search only makes the progress less complete; the run still reads gh itself.
  const ticketPrs = input.ticketPrs ?? (await fetchTicketPrs(key, config.ticketPattern).catch(() => []));
  writeFileSync(join(workDir, "context.md"), await buildContext({ ...input, notes: input.notes ?? db.notesForTicket(key), events: input.events ?? db.sdlcEventsByTicket()[key] ?? [], ticketPrs }));
  const prompt = buildPrompt(key, rec.id, workDir);
  writeFileSync(join(workDir, "prompt.md"), prompt);

  const args = ["-p", "--no-extensions", "--tools", "read,bash", "--session-dir", SESSION_DIR, "--name", `agent-dash summary ${key}`];
  if (process.env.AGENT_DASH_SUMMARY_MODEL) args.push("--model", process.env.AGENT_DASH_SUMMARY_MODEL);
  if (process.env.AGENT_DASH_SUMMARY_THINKING) args.push("--thinking", process.env.AGENT_DASH_SUMMARY_THINKING);
  args.push(prompt);

  const out = openSync(join(workDir, "out.log"), "w");
  const err = openSync(join(workDir, "err.log"), "w");
  const child = spawn("pi", args, {
    cwd: workDir,
    // Detached, with output in files, so a server restart does not kill the run.
    detached: true,
    stdio: ["ignore", out, err],
    // The `pi` shell alias sets this; a spawned pi does not get the alias.
    // AGENT_DASH_SLACK_HITS: slack-search.ts saves its matches there, for the page's quotes.
    env: { ...process.env, SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? "/etc/ssl/cert.pem", AGENT_DASH_SLACK_HITS: join(workDir, SLACK_HITS) },
  });
  closeSync(out);
  closeSync(err);
  child.unref();

  if (child.pid) db.setProcess(rec.id, child.pid, workDir);
  children.set(rec.id, child);
  const timer = setTimeout(() => child.kill("SIGTERM"), STALE_MS);
  timer.unref();
  const done = (code: number | null) => {
    clearTimeout(timer);
    children.delete(rec.id);
    finish(rec.id, code);
    opts.onChange?.();
  };
  child.on("exit", (code) => done(code));
  child.on("error", (e) => {
    db.markFailed(rec.id, `could not start pi: ${e.message}`);
    done(1);
  });
  return db.get(rec.id)!;
}
