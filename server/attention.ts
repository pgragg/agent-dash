import { awaitsOwner, ownerWaitText } from "../shared/ownerApproval.ts";
import { checkList } from "../shared/prVerbs.ts";
import { runTitle } from "../shared/runTitle.ts";
import type { AttentionItem, PullRequest, Run, Ticket } from "../shared/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Tickets in these statuses are parked on purpose, so their dates nag less. */
const PARKED = /hold|blocked|waiting|deferred/i;

export function ago(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}

function priorityBoost(priority: string | null): number {
  if (!priority) return 0;
  if (/P0|highest|blocker/i.test(priority)) return 30;
  if (/P1|critical/i.test(priority)) return 20;
  if (/P2|high/i.test(priority)) return 10;
  return 0;
}

type Draft = Omit<AttentionItem, "ticketUrl">;

function runItems(runs: Run[], now: number): Draft[] {
  const items: Draft[] = [];
  for (const run of runs) {
    const waited = now - Date.parse(run.statusSince);
    const label = runTitle(run).slice(0, 60);
    const base = { ticketKey: run.tickets[0] ?? null, sessionId: run.sessionId, since: run.statusSince, updatedAt: run.lastActivityAt, name: runTitle(run) };
    if (run.status === "awaiting_input" && run.endedInError) {
      items.push({ ...base, kind: "run_error", score: 110, status: "API error", reason: `“${label}” stopped on an API error ${ago(waited)} ago — retry it` });
    } else if (run.status === "awaiting_input") {
      if (waited > DAY) {
        // A tab idle this long is more likely forgotten than blocking; still worth closing.
        items.push({ ...base, kind: "awaiting_input", score: 35, status: `waiting ${ago(waited)}`, reason: `“${label}” has waited ${ago(waited)} — answer it or close the tab` });
        continue;
      }
      let score = 100 + Math.min(waited / MIN, 240) / 4 + (run.askedQuestion ? 30 : 0);
      if (run.statusSource === "heuristic") score *= 0.6; // The log cannot prove the tab is still open.
      const what = run.askedQuestion ? "asked you a question" : "is waiting for you";
      const status = `${run.askedQuestion ? "asked a question" : `waiting ${ago(waited)}`}${run.statusSource === "heuristic" ? " · guess" : ""}`;
      items.push({ ...base, kind: "awaiting_input", score, status, reason: `“${label}” ${what} (${ago(waited)})${run.statusSource === "heuristic" ? " · guess" : ""}` });
    } else if (run.status === "finished" && run.endedInError && waited < DAY) {
      items.push({ ...base, kind: "run_error", score: 90, status: "API error", reason: `“${label}” died on an API error ${ago(waited)} ago` });
    }
  }
  return items;
}

/** After this long with no activity, a PR out for review needs a nudge from you. */
const REVIEW_NUDGE_MS = 2 * DAY;

function prItems(prs: PullRequest[], now: number): Draft[] {
  const items: Draft[] = [];
  for (const pr of prs) {
    if (pr.state !== "open") continue;
    const name = `${pr.repo.split("/")[1]}#${pr.number}${pr.isDraft ? " (draft)" : ""}`;
    const base = { ticketKey: pr.tickets[0] ?? null, prUrl: pr.url, since: pr.updatedAt, updatedAt: pr.updatedAt, name, title: pr.title };
    // A draft is not asking anyone for anything yet, so its problems can wait.
    const weight = pr.isDraft ? 0.5 : 1;
    if (pr.reviewDecision === "CHANGES_REQUESTED") items.push({ ...base, kind: "changes_requested", score: 95 * weight, status: "changes requested", reason: `${name}: a reviewer asked for changes` });
    if (pr.checks === "failure") items.push({ ...base, kind: "ci_failing", score: 85 * weight, status: "CI red", reason: `${name}: CI is red${pr.failedChecks?.length ? `: ${checkList(pr.failedChecks)}` : ""}` });
    if (pr.mergeable === "CONFLICTING") items.push({ ...base, kind: "merge_conflict", score: 80 * weight, status: "conflict", reason: `${name}: merge conflict` });
    const ownerWait = awaitsOwner(pr);
    if (pr.reviewDecision === "APPROVED" && !ownerWait && !pr.isDraft && pr.checks !== "failure" && pr.checks !== "pending" && pr.mergeable !== "CONFLICTING") {
      // An approval can ask for one more change, so it is not "merge it" while feedback waits for an answer.
      const open = pr.toAddress ?? 0;
      const comments = open === 1 ? "1 comment" : `${open} comments`;
      if (open > 0) items.push({ ...base, kind: "approved_with_feedback", score: 75, status: `${open} to address`, reason: `${name}: approved, ${comments} to address` });
      else items.push({ ...base, kind: "ready_to_merge", score: 70, status: "approved", reason: `${name}: approved and green — merge it` });
    } else if (pr.reviewDecision === null && !pr.isDraft && pr.mergeStateStatus === "CLEAN") {
      // The repo requires no review, so a green PR waits only for me.
      items.push({ ...base, kind: "ready_to_merge", score: 70, status: "green", reason: `${name}: needs no review and is green — merge it` });
    }
    // Healthy and waiting for a reviewer: the ball is with them, until it has sat too long.
    if (ownerWait) {
      const quiet = now - Date.parse(pr.updatedAt);
      const wait = ownerWaitText(pr.approvals);
      if (quiet > REVIEW_NUDGE_MS) items.push({ ...base, kind: "in_review", score: 45, status: wait, reason: `${name}: ${wait}, no activity for ${ago(quiet)} — nudge the reviewer` });
      else items.push({ ...base, kind: "in_review", score: 15, info: true, status: wait, reason: `${name}: ${wait}` });
    } else if (pr.reviewDecision === "REVIEW_REQUIRED" && !pr.isDraft && pr.checks !== "failure" && pr.mergeable !== "CONFLICTING") {
      const quiet = now - Date.parse(pr.updatedAt);
      const ci = pr.checks === "success" ? ", CI green" : pr.checks === "pending" ? ", CI running" : "";
      if (quiet > REVIEW_NUDGE_MS) items.push({ ...base, kind: "in_review", score: 45, status: `no review ${ago(quiet)}`, reason: `${name}: no review activity for ${ago(quiet)} — nudge the reviewer` });
      else items.push({ ...base, kind: "in_review", score: 15, info: true, status: "in review", reason: `${name} is out for review${ci} (last activity ${ago(quiet)} ago)` });
    }
  }
  return items;
}

function ticketItems(tickets: Ticket[], runs: Run[], prs: PullRequest[], now: number): Draft[] {
  const items: Draft[] = [];
  const today = new Date(now).toISOString().slice(0, 10);
  for (const t of tickets) {
    if (!t.assignedToMe || t.statusCategory === "done") continue;
    const parked = PARKED.test(t.status) ? -25 : 0;
    const base = { ticketKey: t.key, since: t.updatedAt, updatedAt: t.updatedAt, name: t.key };
    if (t.dueDate && t.dueDate < today) {
      const late = Math.round((Date.parse(today) - Date.parse(t.dueDate)) / DAY);
      items.push({ ...base, kind: "overdue", score: 60 + Math.min(late, 20) + priorityBoost(t.priority) + parked, status: `${late}d late`, reason: `${t.key} was due ${late}d ago (${t.status})` });
    } else if (t.dueDate && Date.parse(t.dueDate) - Date.parse(today) <= 2 * DAY) {
      items.push({ ...base, kind: "due_soon", score: 50 + priorityBoost(t.priority) + parked, status: `due ${t.dueDate === today ? "today" : t.dueDate}`, reason: `${t.key} is due ${t.dueDate === today ? "today" : t.dueDate}` });
    }
    if (t.statusCategory === "indeterminate" && !parked) {
      const mine = runs.filter((r) => r.tickets.includes(t.key));
      const lastRun = Math.max(0, ...mine.map((r) => Date.parse(r.lastActivityAt)));
      const openPr = prs.some((p) => p.state === "open" && p.tickets.includes(t.key));
      if (!openPr && now - lastRun > 3 * DAY) {
        const when = lastRun ? `no agent run for ${ago(now - lastRun)}` : "no agent run yet";
        items.push({ ...base, kind: "stalled", score: 25 + priorityBoost(t.priority), status: "stalled", reason: `${t.key} is ${t.status} with ${when} and no open PR` });
      }
    }
  }
  return items;
}

export function rankAttention(runs: Run[], prs: PullRequest[], tickets: Ticket[], now: number, ticketUrl: (key: string) => string | null = () => null): AttentionItem[] {
  return [...runItems(runs, now), ...prItems(prs, now), ...ticketItems(tickets, runs, prs, now)]
    .map((item) => ({ ...item, ticketUrl: item.ticketKey ? ticketUrl(item.ticketKey) : null }))
    .sort((a, b) => b.score - a.score);
}
