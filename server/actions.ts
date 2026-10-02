import { prRef } from "../shared/refs.ts";
import type { Action, ActionKind, AttentionKind, Dashboard } from "../shared/types.ts";
import type { ActionKey } from "./summaries/db.ts";

/**
 * The Actions view: each queue signal that needs you, and each drafted next step of an open
 * ticket. Every action links to the part of agent-dash where you act on it.
 */

type Source = "sessions" | "github" | "jira" | "summaries";

export interface ActionCandidate extends ActionKey {
  kind: ActionKind;
  summary: string;
  score: number;
  target: string;
  /** The source that tells whether the action is still open. */
  source: Source;
}

const SOURCE: Record<AttentionKind, Source> = {
  awaiting_input: "sessions",
  run_error: "sessions",
  changes_requested: "github",
  ci_failing: "github",
  merge_conflict: "github",
  ready_to_merge: "github",
  in_review: "github",
  overdue: "jira",
  due_soon: "jira",
  stalled: "jira",
};

export function actionCandidates(d: Pick<Dashboard, "attention" | "myTickets" | "otherTickets" | "summaries">): ActionCandidate[] {
  const out: ActionCandidate[] = [];
  for (const a of d.attention) {
    if (a.info) continue;
    const source = SOURCE[a.kind];
    const pr = a.prUrl ? prRef(a.prUrl) : null;
    // attachRuns gives every row a run, so the kind, not the fields, says what the row is about.
    let about: string;
    let target: string;
    if (source === "github" && a.prUrl) {
      about = `pr:${a.prUrl}`;
      target = pr ?? `p:${a.prUrl}`;
    } else if (source === "sessions" && a.sessionId) {
      target = about = `r:${a.sessionId}`;
    } else if (a.ticketKey) {
      target = about = `t:${a.ticketKey}`;
    } else continue;
    out.push({ key: `${a.kind} ${about}`, kind: a.kind, ticket: a.ticketKey, summary: a.reason, score: a.score, target, source });
  }

  // A ticket's top signal breaks ties between next steps at the same position.
  const top = new Map<string, number>();
  for (const a of d.attention) if (a.ticketKey && !top.has(a.ticketKey)) top.set(a.ticketKey, a.score);
  for (const g of [...d.myTickets, ...d.otherTickets]) {
    if (g.ticket.statusCategory === "done") continue;
    const state = d.summaries[g.ticket.key];
    const shown = state?.latest.status === "done" ? state.latest : state?.lastDone;
    if (!shown?.generatedAt) continue;
    for (const step of shown.steps) {
      out.push({
        key: `next_step step:${step.id}`,
        kind: "next_step",
        ticket: g.ticket.key,
        summary: step.body,
        // Below every signal but "stalled", and each ticket's first step before any second step.
        score: 20 - step.position + Math.min(top.get(g.ticket.key) ?? 0, 99) / 100,
        target: `step:${step.id}`,
        source: "summaries",
        createdAt: shown.generatedAt,
      });
    }
  }
  return out;
}

/** Joins the candidates with their rows. A candidate without a row (a race) is left out. */
export function toActions(candidates: ActionCandidate[], rows: Map<string, { id: number; createdAt: string }>, d: Pick<Dashboard, "myTickets" | "otherTickets">): Action[] {
  const titles = new Map([...d.myTickets, ...d.otherTickets].map((g) => [g.ticket.key, g.ticket.summary]));
  const out: Action[] = [];
  for (const c of candidates) {
    const row = rows.get(c.key);
    if (!row) continue;
    out.push({ id: row.id, kind: c.kind, summary: c.summary, ticketKey: c.ticket, ticketSummary: c.ticket ? (titles.get(c.ticket) ?? null) : null, createdAt: row.createdAt, score: c.score, target: c.target });
  }
  return out.sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt));
}

/**
 * The key's source could not be read this time, so a missing action is unknown, not done.
 * Without this, a GitHub timeout would clear every PR action and restart its age.
 */
export function keepWhenDown(sources: Dashboard["sources"]): (key: string) => boolean {
  const down = new Set<Source>();
  if (!sources.sessions.ok) down.add("sessions");
  if (!sources.github.ok) down.add("github");
  if (!sources.jira.ok) down.add("jira");
  return (key) => {
    const kind = key.split(" ")[0];
    return kind in SOURCE && down.has(SOURCE[kind as AttentionKind]);
  };
}
