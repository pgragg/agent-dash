/**
 * Record an SDLC event on one or more tickets. Agents call this after a smoketest, or after
 * they confirm a deploy in Argo:
 *
 *   node scripts/sdlc-event.ts smoketest --ticket ABC-123 --env localhost \
 *     --started 2026-10-05T10:00:00Z --finished 2026-10-05T10:20:00Z --outcome passed \
 *     --details-file details.md --results-file results.md
 *   node scripts/sdlc-event.ts deploy --ticket ABC-123 --env staging --details "<app>: Synced, Healthy, 1.2.3"
 *
 * A deploy that is live but does not give its benefit yet takes `--outcome unhealthy`, and shows yellow.
 *
 * `smoketest` records a smoketest_execution. A smoketest that agent-dash started has a plan first;
 * the agent records the plan, then finishes the execution that the accepted plan starts:
 *
 *   node scripts/sdlc-event.ts plan --id 11 --summary "Place a test order locally and load it" --plan-file plan.md --state-changes none
 *   node scripts/sdlc-event.ts plan --id 11 --summary "…" --writes-summary "Staging: create one test project, then delete it" \
 *     --plan-file plan.md --state-changes-file writes.md
 *   node scripts/sdlc-event.ts finish --id 12 --outcome passed --summary "Checkout flow works end to end" --details-file details.md --results-file results.md
 *
 * An agent that agent-dash did not start has no plan id. It names the ticket and the environment
 * instead, and the script makes the plan, linked to the agent's pi session (`PI_SESSION_ID`):
 *
 *   node scripts/sdlc-event.ts plan --ticket ABC-123 --env staging --summary "…" --plan-file plan.md --state-changes none
 *
 * A plan with `--state-changes none` changes no Beta or Prod state, so it is accepted at once, and
 * the script prints how to run it. Any other plan waits for Piper's Confirm in agent-dash.
 *
 * --ticket and --env can repeat. An environment is localhost, or an id (staging) or label ("Staging") from the `environments` setting.
 * Prints the new event as JSON.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { config } from "../server/config.ts";
import { startExecution, validateSdlcEvent, validateSdlcFinish, validateSdlcPlan } from "../server/sdlc.ts";
import * as db from "../server/summaries/db.ts";
import { user } from "../shared/team.ts";

const USAGE = `usage: node scripts/sdlc-event.ts smoketest|deploy --ticket KEY [--ticket KEY] --env ENV [--env ENV] [--started ISO] [--finished ISO] [--outcome passed|failed|blocked (smoketest) | unhealthy (deploy)] [--summary TEXT] [--details TEXT | --details-file F] [--results TEXT | --results-file F]
       node scripts/sdlc-event.ts plan (--id N | --ticket KEY --env ENV) --summary TEXT (--plan TEXT | --plan-file F) (--state-changes none | (--state-changes TEXT | --state-changes-file F) --writes-summary TEXT)
       node scripts/sdlc-event.ts finish --id N --outcome passed|failed|blocked [--finished ISO] [--summary TEXT] [--details TEXT | --details-file F] [--results TEXT | --results-file F]`;

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
      summary: { type: "string" },
      details: { type: "string" },
      "details-file": { type: "string" },
      results: { type: "string" },
      "results-file": { type: "string" },
      plan: { type: "string" },
      "plan-file": { type: "string" },
      "state-changes": { type: "string" },
      "state-changes-file": { type: "string" },
      "writes-summary": { type: "string" },
    },
  });
  const read = (f: string | undefined, v: string | undefined) => (f ? readFileSync(f, "utf8") : v);
  if (positionals[0] === "plan") {
    const id = values.id === undefined ? newPlan(values.ticket, values.env) : Number(values.id);
    const planned = db.recordPlan(id, validateSdlcPlan({ plan: read(values["plan-file"], values.plan), stateChanges: read(values["state-changes-file"], values["state-changes"]), summary: values.summary, writesSummary: values["writes-summary"] }));
    if (!planned) throw new Error(`no plan with --id ${values.id ?? ""} that is still open: a confirmed plan cannot change. Ask ${user()} to start a new plan.`);
    if (!planned.confirmedAt) {
      console.log(`Recorded the plan (SDLC event ${id}). It changes Beta or Prod state, so it waits for ${user()}'s confirmation in agent-dash. Reply with a short summary of the plan, and stop.`);
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
    const done = db.finishSdlcEvent(id, validateSdlcFinish({ finishedAt: values.finished, outcome: values.outcome, summary: values.summary, testDetails: read(values["details-file"], values.details), testResults: read(values["results-file"], values.results) }, running.startedAt));
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
      summary: values.summary,
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

/** A plan for an agent that agent-dash did not start: the stage then shows that the plan exists. */
function newPlan(tickets: string[] | undefined, envs: string[] | undefined): number {
  if (tickets?.length !== 1 || envs?.length !== 1) throw new Error("a plan with no --id needs one --ticket and one --env");
  // Checks the key and the environment as for a result; the plan itself is made as the server makes it.
  const { tickets: [ticket], environments: [env] } = validateSdlcEvent({ eventType: "smoketest_execution", tickets, environments: envs }, config.ticketPattern);
  return db.addSdlcEvent({ eventType: "smoketest_plan", startedAt: new Date().toISOString(), environments: [env], tickets: [ticket], sessionId: process.env.PI_SESSION_ID || null }).id;
}
