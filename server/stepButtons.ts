import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanLabel, LABEL_VERSION, stepLabelPrompt } from "../shared/stepButton.ts";
import type { Dashboard, NextStep, TicketGroup } from "../shared/types.ts";
import { draftCommand } from "./agent.ts";
import { config } from "./config.ts";
import * as db from "./summaries/db.ts";

const run = promisify(execFile);

/** Each draft is its own agent process; more than this at once only slows the machine. */
const PARALLEL = 4;
/** A failed or stuck draft is tried again on a page load after this. */
const RETRY_MS = 5 * 60_000;

/** The top step of each open ticket's newest finished draft: the step that its kanban card shows. The claim skips the ones with a current label. */
export function topSteps(groups: TicketGroup[], summaries: Dashboard["summaries"]): NextStep[] {
  return groups.flatMap((g) => {
    if (g.ticket.statusCategory === "done") return [];
    const state = summaries[g.ticket.key];
    const shown = state?.latest.status === "done" ? state.latest : state?.lastDone;
    const step = shown?.steps[0];
    return step ? [step] : [];
  });
}

/** One label: one tool-less agent turn with the cheap model. */
export async function draftOne(step: NextStep): Promise<string | null> {
  const { cmd, args, env } = draftCommand(config.agent, stepLabelPrompt(step.ticket, step.body));
  const agent = run(cmd, args, { timeout: 90_000, env });
  // `-p` waits for stdin to close before it starts.
  agent.child.stdin?.end();
  const { stdout } = await agent;
  return cleanLabel(stdout.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""));
}

/**
 * Starts a label draft for each top step with no current label, at most PARALLEL at a time, and returns at
 * once with the step ids it took. A new next-steps draft makes new step rows, so the card follows it.
 */
export function requestStepLabels(steps: NextStep[], onChange: () => void, draft = draftOne, now = new Date()): number[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const queue = db.claimStepLabels([...byId.keys()], LABEL_VERSION, new Date(now.getTime() - RETRY_MS).toISOString(), now).map((id) => byId.get(id)!);
  const started = queue.map((s) => s.id);
  const worker = async () => {
    for (let step = queue.shift(); step; step = queue.shift()) {
      const label = await draft(step).catch((err: Error) => {
        console.warn(`step label for ${step!.ticket}: ${err.message.split("\n").at(-1)}`);
        return null;
      });
      if (db.finishStepLabel(step.id, label)) onChange();
    }
  };
  // Counted first: each worker takes a step off the queue as it starts.
  const workers = Math.min(PARALLEL, queue.length);
  for (let i = 0; i < workers; i++) void worker();
  return started;
}
