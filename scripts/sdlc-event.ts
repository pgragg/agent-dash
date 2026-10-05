/**
 * Record an SDLC event on one or more tickets. Agents call this after a smoketest, or after
 * they confirm a deploy in Argo:
 *
 *   node scripts/sdlc-event.ts smoketest --ticket FSDK-1 --env localhost \
 *     --started 2026-10-05T10:00:00Z --finished 2026-10-05T10:20:00Z --outcome passed \
 *     --details-file details.md --results-file results.md
 *   node scripts/sdlc-event.ts deploy --ticket FSDK-1 --env postman_beta --details "<app>: Synced, Healthy, 1.2.3"
 *
 * A smoketest that agent-dash started already has a running event; the agent finishes that one:
 *
 *   node scripts/sdlc-event.ts finish --id 12 --outcome passed --summary "Publish flow works end to end" --details-file details.md --results-file results.md
 *
 * --ticket and --env can repeat. An environment is an id (postman_beta) or a label ("Postman Beta").
 * Prints the new event as JSON.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { config } from "../server/config.ts";
import { validateSdlcEvent, validateSdlcFinish } from "../server/sdlc.ts";
import * as db from "../server/summaries/db.ts";

const USAGE = `usage: node scripts/sdlc-event.ts smoketest|deploy --ticket KEY [--ticket KEY] --env ENV [--env ENV] [--started ISO] [--finished ISO] [--outcome passed|failed|blocked] [--summary TEXT] [--details TEXT | --details-file F] [--results TEXT | --results-file F]
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
    },
  });
  const read = (f: string | undefined, v: string | undefined) => (f ? readFileSync(f, "utf8") : v);
  if (positionals[0] === "finish") {
    const id = Number(values.id);
    const running = Number.isInteger(id) ? db.getSdlcEvent(id) : null;
    if (running?.eventType !== "smoketest") throw new Error(`no smoketest event with --id ${values.id ?? ""}`);
    const done = db.finishSdlcEvent(id, validateSdlcFinish({ finishedAt: values.finished, outcome: values.outcome, summary: values.summary, testDetails: read(values["details-file"], values.details), testResults: read(values["results-file"], values.results) }, running.startedAt));
    if (!done) throw new Error(`SDLC event ${id} already has a result`);
    console.log(JSON.stringify(done, null, 2));
    process.exit(0);
  }
  const event = validateSdlcEvent(
    {
      eventType: positionals[0],
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
