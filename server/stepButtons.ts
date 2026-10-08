import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { moveStepTarget, moveTargets } from "../shared/jiraVerbs.ts";
import { cleanLabel, LABEL_VERSION, moveLabel, stepLabelPrompt } from "../shared/stepButton.ts";
import type { Dashboard, NextStep, StepAction, Ticket, TicketDetail, TicketGroup } from "../shared/types.ts";
import { draftCommand } from "./agent.ts";
import { config } from "./config.ts";
import { stepMessage } from "./handoff.ts";
import * as db from "./summaries/db.ts";
import { ticketProviders } from "./tickets/registry.ts";

const run = promisify(execFile);

/** Each draft is its own agent process; more than this at once only slows the machine. */
const PARALLEL = 4;
/** A failed or stuck draft is tried again on a page load after this. */
const RETRY_MS = 5 * 60_000;

export interface TopStep {
  step: NextStep;
  ticket: Ticket;
}

export interface LabelDeps {
  draft: (step: NextStep, message: string) => Promise<string | null>;
  detail: (key: string) => Promise<TicketDetail | null>;
}

/** The top step of each open ticket's newest finished draft: the step that its kanban card shows. The claim skips the ones with a current label. */
export function topSteps(groups: TicketGroup[], summaries: Dashboard["summaries"]): TopStep[] {
  return groups.flatMap((g) => {
    if (g.ticket.statusCategory === "done") return [];
    const state = summaries[g.ticket.key];
    const shown = state?.latest.status === "done" ? state.latest : state?.lastDone;
    const step = shown?.steps[0];
    return step ? [{ step, ticket: g.ticket }] : [];
  });
}

/**
 * What the button does, decided once, as the step's own button in the Next steps card decides it:
 * a step that only moves the ticket is a move, else an agent with the step's first message.
 */
export async function actionFor({ step, ticket }: TopStep, detail: LabelDeps["detail"]): Promise<StepAction> {
  if (ticket.source.move && /\bmov/i.test(step.body)) {
    const d = await detail(ticket.key);
    if (!d) throw new Error(`${ticket.key}: no ticket detail`);
    // The current status counts too: the page then shows "already <status>" instead of a button.
    const target = moveStepTarget(step.body, ticket.key, [...moveTargets(d.transitions, d.status), { to: d.status, via: null }]);
    if (target) return { kind: "move", to: target.to };
  }
  return { kind: "agent", message: stepMessage(ticket.key, step.body) };
}

/** One label: one tool-less agent turn with the cheap model, from the agent's exact first message. */
export async function draftOne(step: NextStep, message: string): Promise<string | null> {
  const { cmd, args, env } = draftCommand(config.agent, stepLabelPrompt(step.ticket, step.id, message));
  const agent = run(cmd, args, { timeout: 90_000, env });
  // `-p` waits for stdin to close before it starts.
  agent.child.stdin?.end();
  const { stdout } = await agent;
  return cleanLabel(stdout.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""));
}

const defaults: LabelDeps = { draft: draftOne, detail: (key) => ticketProviders.providerFor(key)?.detail(key, false) ?? Promise.resolve(null) };

/**
 * Starts a label draft for each top step with no current label, at most PARALLEL at a time, and
 * returns at once with the step ids it took. A new next-steps draft makes new step rows, so the
 * card follows it.
 */
export function requestStepLabels(tops: TopStep[], onChange: () => void, deps: LabelDeps = defaults, now = new Date()): number[] {
  const byId = new Map(tops.map((t) => [t.step.id, t]));
  const queue = db.claimStepLabels([...byId.keys()], LABEL_VERSION, new Date(now.getTime() - RETRY_MS).toISOString(), now).map((id) => byId.get(id)!);
  const started = queue.map((t) => t.step.id);
  const fail = (t: TopStep) => (err: Error) => {
    console.warn(`step button for ${t.ticket.key}: ${err.message.split("\n").at(-1)}`);
    return null;
  };
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const action = await actionFor(t, deps.detail).catch(fail(t));
      const label = !action ? null : action.kind === "move" ? moveLabel(action.to) : await deps.draft(t.step, action.message).catch(fail(t));
      if (db.finishStepLabel(t.step.id, action, label)) onChange();
    }
  };
  // Counted first: each worker takes a step off the queue as it starts.
  const workers = Math.min(PARALLEL, queue.length);
  for (let i = 0; i < workers; i++) void worker();
  return started;
}
