import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { buildHandoff } from "../server/handoff.ts";
import { validateSdlcEvent } from "../server/sdlc.ts";
import * as db from "../server/summaries/db.ts";
import { buildContext, buildPrompt, redraftAfterNewEvents } from "../server/summaries/runner.ts";
import { confirmDeployMessage, parseEnvironment, sdlcProgress, smoketestMessage } from "../shared/sdlc.ts";
import type { SdlcEvent } from "../shared/types.ts";
import { NOW, PATTERN, pr, ticket } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-dash-sdlc-"));
const dbPath = join(dir, "test.db");
db.open(dbPath);

let nextId = 1;
function ev(over: Partial<SdlcEvent> = {}): SdlcEvent {
  return {
    id: nextId++,
    eventType: "smoketest",
    startedAt: "2026-10-02T10:00:00.000Z",
    finishedAt: null,
    outcome: "passed",
    testDetails: null,
    testResults: null,
    skippedAt: null,
    environments: ["localhost"],
    tickets: ["FSDK-1"],
    createdAt: "2026-10-02T10:00:00.000Z",
    ...over,
  };
}

const states = (p: ReturnType<typeof sdlcProgress>) => Object.fromEntries(p.stages.map((s) => [s.id, s.state]));

test("a new ticket is at Ideation, and the next stage is a PR", () => {
  const p = sdlcProgress({ ticket: ticket(), prs: [], events: [] });
  assert.equal(p.stages.length, 8);
  assert.equal(p.stages[p.current].id, "ideation");
  assert.equal(p.next?.id, "pr");
  // A closed PR is not a PR that exists.
  assert.equal(sdlcProgress({ ticket: ticket(), prs: [pr({ state: "closed" })], events: [] }).next?.id, "pr");
});

test("with a PR and no local smoketest, the next step is a local smoketest before the review", () => {
  const p = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [] });
  assert.equal(p.next?.id, "local_smoketest");
  assert.match(p.hint!, /smoketest on localhost before you ask for a PR review/);
});

test("a later stage that is done marks the open stages before it as skipped, and the order goes on", () => {
  const p = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [ev({ eventType: "deploy", environments: ["postman_beta"], testDetails: "Checked off by hand in agent-dash" })] });
  assert.equal(states(p).local_smoketest, "skipped");
  assert.equal(states(p).in_beta, "done");
  assert.equal(p.stages[p.current].detail, "Checked off by hand in agent-dash");
  assert.equal(p.next?.id, "beta_smoketest");
  assert.match(p.hint!, /smoketest on Postman Beta before you open the prod chart version update PR/);
});

test("the newest smoketest decides: a failure shows red, a later pass makes it done again", () => {
  const failed = ev({ outcome: "failed", startedAt: "2026-10-02T10:00:00.000Z" });
  const p = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [failed] });
  assert.equal(states(p).local_smoketest, "failed");
  assert.equal(p.next?.id, "local_smoketest");
  assert.match(p.hint!, /failed\. Fix it/);
  const fixed = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [failed, ev({ startedAt: "2026-10-02T11:00:00.000Z" })] });
  assert.equal(states(fixed).local_smoketest, "done");
  // A failed smoketest is not progress, so it never marks earlier stages skipped.
  assert.equal(sdlcProgress({ ticket: ticket(), prs: [], events: [failed] }).current, 0);
});

test("a merged deploy PR with no confirmed deploy waits for Argo; Fern Dev counts for Beta", () => {
  const deploy = pr({ url: "https://github.com/postman-eng/cloud9-parcels-deployments/pull/7", repo: "postman-eng/cloud9-parcels-deployments", number: 7, state: "merged" });
  const p = sdlcProgress({ ticket: ticket(), prs: [pr(), deploy], events: [ev()] });
  assert.equal(states(p).in_beta, "waiting");
  assert.match(p.hint!, /Deploy PR #7 merged; confirm the deploy in Argo/);
  const smoked = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [ev({ environments: ["fern_dev"] })] });
  assert.equal(states(smoked).beta_smoketest, "done");
  assert.equal(states(smoked).in_beta, "skipped");
});

test("a skipped smoketest passes its stage on purpose, and a later run decides again", () => {
  const skip = ev({ outcome: null, skippedAt: "2026-10-02T10:00:00.000Z" });
  const p = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [skip] });
  assert.equal(states(p).local_smoketest, "skipped");
  assert.match(p.stages[p.current].detail, /skipped 2026-10-02/);
  assert.equal(p.next?.id, "in_beta");
  const ran = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [skip, ev({ outcome: "failed", startedAt: "2026-10-02T11:00:00.000Z" })] });
  assert.equal(states(ran).local_smoketest, "failed");
});

test("Done comes from Jira, and then there is no next stage", () => {
  const p = sdlcProgress({ ticket: ticket({ status: "Done", statusCategory: "done" }), prs: [pr({ state: "merged" })], events: [] });
  assert.equal(p.stages[p.current].id, "done");
  assert.equal(p.next, null);
  assert.equal(states(p).prod_smoketest, "skipped");
});

test("an environment is an id or a label", () => {
  assert.equal(parseEnvironment("postman_beta"), "postman_beta");
  assert.equal(parseEnvironment("Postman Beta"), "postman_beta");
  assert.equal(parseEnvironment("fern-prod"), "fern_prod");
  assert.equal(parseEnvironment("staging"), null);
});

test("an event links to each ticket and environment, newest first, and a delete removes its links", () => {
  const older = db.addSdlcEvent({ eventType: "smoketest", startedAt: "2026-10-01T10:00:00.000Z", environments: ["localhost"], tickets: ["FSDK-20"] });
  const newer = db.addSdlcEvent({ eventType: "smoketest", startedAt: "2026-10-02T10:00:00.000Z", outcome: "failed", testDetails: "local FE", testResults: "500", environments: ["localhost", "postman_beta"], tickets: ["FSDK-20", "FSDK-21"] });
  const by = db.sdlcEventsByTicket();
  assert.deepEqual(by["FSDK-20"].map((e) => e.id), [newer.id, older.id]);
  assert.deepEqual(by["FSDK-21"].map((e) => e.id), [newer.id]);
  assert.deepEqual(newer.environments.sort(), ["localhost", "postman_beta"]);
  assert.equal(newer.outcome, "failed");
  assert.equal(newer.testResults, "500");
  assert.equal(db.deleteSdlcEvent(newer.id), true);
  assert.equal(db.sdlcEventsByTicket()["FSDK-21"], undefined);
  assert.equal(db.deleteSdlcEvent(newer.id), false);
  const skip = db.addSdlcEvent({ eventType: "smoketest", startedAt: "2026-10-02T12:00:00.000Z", skippedAt: "2026-10-02T12:00:00.000Z", environments: ["postman_beta"], tickets: ["FSDK-22"] });
  assert.equal(db.sdlcEventsByTicket()["FSDK-22"][0].skippedAt, skip.skippedAt);
  assert.equal(skip.skippedAt, "2026-10-02T12:00:00.000Z");
  assert.equal(older.skippedAt, null);
});

test("a database from before skips gets the skipped_at column", () => {
  const old = join(dir, "old.db");
  new DatabaseSync(old).exec(
    "CREATE TABLE SDLC_Event (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT, test_details TEXT, test_results TEXT, created_at TEXT NOT NULL)",
  );
  const script = new URL("../scripts/sdlc-event.ts", import.meta.url).pathname;
  const out = JSON.parse(execFileSync("node", [script, "smoketest", "--ticket", "FSDK-31", "--env", "localhost"], { env: { ...process.env, AGENT_DASH_DB: old } }).toString());
  assert.equal(out.skippedAt, null);
});

test("a new event is checked: a known type, real keys, known environments, and times in order", () => {
  const now = new Date(NOW);
  const ok = validateSdlcEvent({ eventType: "smoketest", tickets: ["FSDK-1"], environments: ["Postman Beta"] }, PATTERN, now);
  assert.equal(ok.startedAt, now.toISOString());
  assert.deepEqual(ok.environments, ["postman_beta"]);
  assert.throws(() => validateSdlcEvent({ eventType: "review", tickets: ["FSDK-1"], environments: ["localhost"] }, PATTERN), /eventType/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest", tickets: ["FSDK-1 OR 1=1"], environments: ["localhost"] }, PATTERN), /not a ticket key/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest", tickets: ["FSDK-1"], environments: ["staging"] }, PATTERN), /unknown environment/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest", tickets: ["FSDK-1"], environments: [] }, PATTERN), /at least one environment/);
  const skipped = validateSdlcEvent({ eventType: "smoketest", tickets: ["FSDK-1"], environments: ["localhost"], skippedAt: new Date(NOW).toISOString() }, PATTERN, now);
  assert.equal(skipped.skippedAt, now.toISOString());
  assert.throws(() => validateSdlcEvent({ eventType: "deploy", tickets: ["FSDK-1"], environments: ["localhost"], skippedAt: new Date(NOW).toISOString() }, PATTERN), /only a smoketest/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest", tickets: ["FSDK-1"], environments: ["localhost"], skippedAt: new Date(NOW).toISOString(), outcome: "passed" }, PATTERN), /no outcome/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest", tickets: ["FSDK-1"], environments: ["localhost"], startedAt: "2026-10-02T12:00:00Z", finishedAt: "2026-10-02T11:00:00Z" }, PATTERN), /before startedAt/);
});

test("the script that agents call writes into the same database", () => {
  const script = new URL("../scripts/sdlc-event.ts", import.meta.url).pathname;
  const results = join(dir, "results.md");
  writeFileSync(results, "All green.\n");
  const env = { ...process.env, AGENT_DASH_DB: dbPath };
  const out = JSON.parse(execFileSync("node", [script, "smoketest", "--ticket", "FSDK-30", "--env", "Postman Prod", "--outcome", "passed", "--details", "GET /health", "--results-file", results], { env }).toString());
  assert.equal(out.eventType, "smoketest");
  assert.equal(db.sdlcEventsByTicket()["FSDK-30"][0].testResults, "All green.");
  assert.throws(() => execFileSync("node", [script, "smoketest", "--ticket", "FSDK-30"], { env, stdio: "pipe" }));
});

test("verb messages name the environment and the record command; the summary prompt carries the order", async () => {
  const m = smoketestMessage("FSDK-1", "localhost", "/dash/scripts/sdlc-event.ts");
  assert.match(m, /^Run a smoketest of FSDK-1 on localhost\./);
  assert.match(m, /Local smoketesting\.md/);
  assert.match(m, /node \/dash\/scripts\/sdlc-event\.ts smoketest --ticket FSDK-1 --env localhost/);
  assert.match(smoketestMessage("FSDK-1", "postman_prod", "/s"), /real customer traffic/);
  const c = confirmDeployMessage("FSDK-1", "beta", ["https://github.com/postman-eng/cloud9-parcels-deployments/pull/7"], "/s");
  assert.match(c, /Do not sync, roll back, or change anything/);
  assert.match(c, /deploy --ticket FSDK-1 --env postman_beta/);

  assert.match(buildPrompt("FSDK-1", 1, "/w"), /local smoketest comes before a PR review request/);
  const ctx = await buildContext({ ticket: ticket(), runs: [], prs: [pr()], events: [], ticketPrs: [] });
  assert.match(ctx, /## SDLC progress of FSDK-1/);
  assert.match(ctx, /Next stage: Local smoketest\./);
  const handoff = buildHandoff({ group: { ticket: ticket(), runs: [], prs: [pr()], threads: {} }, notes: [], summary: undefined, events: [ev()], now: new Date(NOW) });
  assert.match(handoff, /\[x\] Local smoketest/);
});

test("a new event starts one next-steps draft per ticket on the board, and replaces a draft that started before it", () => {
  db.claimNewEventTickets(); // the events of the tests above
  db.createRequest("FSDK-40", new Date(Date.now() - 60_000));
  db.addSdlcEvent({ eventType: "smoketest", startedAt: "2026-10-02T10:00:00.000Z", environments: ["localhost"], tickets: ["FSDK-40", "FSDK-41"] });
  db.addSdlcEvent({ eventType: "deploy", startedAt: "2026-10-02T11:00:00.000Z", environments: ["postman_beta"], tickets: ["FSDK-40"] });
  const calls: { key: string; force?: boolean }[] = [];
  const start = async (g: { ticket: { key: string } }, opts?: { force?: boolean }) => (calls.push({ key: g.ticket.key, force: opts?.force }), {} as db.SummaryRecord);
  const groups = [{ ticket: ticket({ key: "FSDK-40" }), runs: [], prs: [] }];
  // FSDK-41 is not on the board, so it gets no draft, and does not stay pending.
  assert.deepEqual(redraftAfterNewEvents(groups, undefined, start), ["FSDK-40"]);
  assert.deepEqual(calls, [{ key: "FSDK-40", force: true }]);
  assert.equal(db.hasNewEventTickets(), false);
  assert.deepEqual(redraftAfterNewEvents(groups, undefined, start), []);
});

test("an upgrade counts the event links that are already there as drafted", () => {
  const old = join(dir, "old-links.db");
  const o = new DatabaseSync(old);
  o.exec("CREATE TABLE SDLC_Event_Ticket (id INTEGER PRIMARY KEY AUTOINCREMENT, sdlc_event_id INTEGER NOT NULL, ticket TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (sdlc_event_id, ticket))");
  o.exec("INSERT INTO SDLC_Event_Ticket (sdlc_event_id, ticket, created_at) VALUES (99, 'FSDK-50', '2026-10-01T00:00:00.000Z')");
  const script = new URL("../scripts/sdlc-event.ts", import.meta.url).pathname;
  execFileSync("node", [script, "smoketest", "--ticket", "FSDK-51", "--env", "localhost"], { env: { ...process.env, AGENT_DASH_DB: old } });
  const rows = o.prepare("SELECT ticket, summary_requested_at AS at FROM SDLC_Event_Ticket ORDER BY id").all() as { ticket: string; at: string | null }[];
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ ticket: "FSDK-50", at: "2026-10-01T00:00:00.000Z" }, { ticket: "FSDK-51", at: null }]);
});
