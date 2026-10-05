/**
 * Record an SDLC event on one or more tickets. Agents call this after a smoketest, or after
 * they confirm a deploy in Argo:
 *
 *   node scripts/sdlc-event.ts smoketest --ticket ABC-123 --env localhost \
 *     --started 2026-10-05T10:00:00Z --finished 2026-10-05T10:20:00Z --outcome passed \
 *     --details-file details.md --results-file results.md
 *   node scripts/sdlc-event.ts deploy --ticket ABC-123 --env postman_beta --details "<app>: Synced, Healthy, 1.2.3"
 *
 * `smoketest` records a smoketest_execution. A smoketest that agent-dash started has a plan first;
 * the agent records the plan, then finishes the execution that the accepted plan starts:
 *
 *   node scripts/sdlc-event.ts plan --id 11 --plan-file plan.md --state-changes none
 *   node scripts/sdlc-event.ts plan --id 11 --plan-file plan.md --state-changes-file writes.md
 *   node scripts/sdlc-event.ts finish --id 12 --outcome passed --details-file details.md --results-file results.md
 *
 * A plan with `--state-changes none` changes no Beta or Prod state, so it is accepted at once, and
 * the script prints how to run it. Any other plan waits for Piper's Confirm in agent-dash.
 *
 * --ticket and --env can repeat. An environment is an id (postman_beta) or a label ("Postman Beta").
 * Prints the new event as JSON.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { config } from "../server/config.ts";
import { startExecution, validateSdlcEvent, validateSdlcFinish, validateSdlcPlan } from "../server/sdlc.ts";
import * as db from "../server/summaries/db.ts";

const USAGE = `usage: node scripts/sdlc-event.ts smoketest|deploy --ticket KEY [--ticket KEY] --env ENV [--env ENV] [--started ISO] [--finished ISO] [--outcome passed|failed|blocked] [--details TEXT | --details-file F] [--results TEXT | --results-file F]
       node scripts/sdlc-event.ts plan --id N (--plan TEXT | --plan-file F) (--state-changes none|TEXT | --state-changes-file F)
       node scripts/sdlc-event.ts finish --id N --outcome passed|failed|blocked [--finished ISO] [--details TEXT | --details-file F] [--results TEXT | --results-file F]`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      id: { type: "string" },
      ticket: { type: "string", multiple: true },
      env: { type: "string", multiple: true },
      started: { type: "string" },
      finished: { type: "string" },
      outcome: { type: "string" },
      details: { type: "string" },
      "details-file": { type: "string" },
      results: { type: "string" },
      "results-file": { type: "string" },
      plan: { type: "string" },
      "plan-file": { type: "string" },
      "state-changes": { type: "string" },
      "state-changes-file": { type: "string" },
    },
  });
  const read = (f: string | undefined, v: string | undefined) => (f ? readFileSync(f, "utf8") : v);
  if (positionals[0] === "plan") {
    const id = Number(values.id);
    const planned = db.recordPlan(id, validateSdlcPlan({ plan: read(values["plan-file"], values.plan), stateChanges: read(values["state-changes-file"], values["state-changes"]) }));
    if (!planned) throw new Error(`no plan with --id ${values.id ?? ""} that is still open: a confirmed plan cannot change. Ask Piper to start a new plan.`);
    if (!planned.confirmedAt) {
      console.log(`Recorded the plan (SDLC event ${id}). It changes Beta or Prod state, so it waits for Piper's confirmation in agent-dash. Reply with a short summary of the plan, and stop.`);
      process.exit(0);
    }
    const { message } = startExecution(planned, planned.sessionId, new URL(import.meta.url).pathname);
    console.log(message);
    process.exit(0);
  }
  if (positionals[0] === "finish") {
    const id = Number(values.id);
    const running = Number.isInteger(id) ? db.getSdlcEvent(id) : null;
    if (running?.eventType !== "smoketest_execution") throw new Error(`no smoketest execution with --id ${values.id ?? ""}`);
    const done = db.finishSdlcEvent(id, validateSdlcFinish({ finishedAt: values.finished, outcome: values.outcome, testDetails: read(values["details-file"], values.details), testResults: read(values["results-file"], values.results) }, running.startedAt));
    if (!done) throw new Error(`SDLC event ${id} already has a result`);
    console.log(JSON.stringify(done, null, 2));
    process.exit(0);
  }
  const event = validateSdlcEvent(
    {
      eventType: positionals[0] === "smoketest" ? "smoketest_execution" : positionals[0],
      tickets: values.ticket,
      environments: values.env,
      startedAt: values.started,
      finishedAt: values.finished,
      outcome: values.outcome,
      testDetails: read(values["details-file"], values.details),
      testResults: read(values["results-file"], values.results),
    },
    config.ticketPattern,
  );
  console.log(JSON.stringify(db.addSdlcEvent(event), null, 2));
} catch (err) {
  console.error(`${(err as Error).message}\n${USAGE}`);
  process.exit(2);
}
