import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { buildHandoff } from "../server/handoff.ts";
import { validateSdlcEvent, validateSdlcPlan } from "../server/sdlc.ts";
import * as db from "../server/summaries/db.ts";
import { buildContext, buildPrompt, redraftAfterNewEvents } from "../server/summaries/runner.ts";
import { confirmDeployMessage, executeMessage, parseEnvironment, planMessage, sdlcProgress } from "../shared/sdlc.ts";
import type { SdlcEvent } from "../shared/types.ts";
import { NOW, PATTERN, pr, ticket } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-dash-sdlc-"));
const dbPath = join(dir, "test.db");
db.open(dbPath);

let nextId = 1;
function ev(over: Partial<SdlcEvent> = {}): SdlcEvent {
  return {
    id: nextId++,
    eventType: "smoketest_execution",
    startedAt: "2026-10-02T10:00:00.000Z",
    finishedAt: null,
    outcome: "passed",
    testDetails: null,
    testResults: null,
    sessionId: null,
    skippedAt: null,
    summary: null,
    prUrl: null,
    channel: null,
    message: null,
    messageUrl: null,
    plannedAt: null,
    stateChanges: null,
    writesSummary: null,
    confirmedAt: null,
    confirmedBy: null,
    planId: null,
    environments: ["localhost"],
    tickets: ["FSDK-1"],
    createdAt: "2026-10-02T10:00:00.000Z",
    ...over,
  };
}

/** An accepted plan, so the execution stage after it is next. */
function plan(over: Partial<SdlcEvent> = {}): SdlcEvent {
  return ev({ eventType: "smoketest_plan", outcome: null, startedAt: "2026-10-02T09:00:00.000Z", plannedAt: "2026-10-02T09:10:00.000Z", confirmedAt: "2026-10-02T09:10:00.000Z", confirmedBy: "auto", testDetails: "1. Open the page.", ...over });
}

const states = (p: ReturnType<typeof sdlcProgress>) => Object.fromEntries(p.stages.map((s) => [s.id, s.state]));

test("a new ticket is at Ideation, and the next stage is a PR", () => {
  const p = sdlcProgress({ ticket: ticket(), prs: [], events: [] });
  assert.equal(p.stages.length, 12);
  assert.equal(p.stages[p.current].id, "ideation");
  assert.equal(p.next?.id, "pr");
  // A closed PR is not a PR that exists.
  assert.equal(sdlcProgress({ ticket: ticket(), prs: [pr({ state: "closed" })], events: [] }).next?.id, "pr");
});

test("with a PR and no local smoketest, the next step is a local smoketest plan before the review", () => {
  const p = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [] });
  assert.equal(p.next?.id, "local_smoketest_plan");
  assert.match(p.hint!, /Plan a smoketest on localhost before you ask for a PR review\. A plan that changes no Beta or Prod state is accepted at once/);
});

test("each smoketest is two stages, plan then execution, for local, Beta and Prod in that order", () => {
  const ids = sdlcProgress({ ticket: ticket(), prs: [], events: [] }).stages.map((s) => s.id);
  assert.deepEqual(ids, ["ideation", "pr", "local_smoketest_plan", "local_smoketest", "review_requested", "in_beta", "beta_smoketest_plan", "beta_smoketest", "in_prod", "prod_smoketest_plan", "prod_smoketest", "done"]);
});

test("a plan is running while its agent writes it, waits when it changes Beta or Prod state, and is done once accepted", () => {
  const writing = plan({ sessionId: "p-1", plannedAt: null, confirmedAt: null, confirmedBy: null, testDetails: null });
  const p = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [writing] });
  assert.equal(states(p).local_smoketest_plan, "running");
  assert.match(p.hint!, /An agent writes the plan since 2026-10-02 09:00 UTC\. It records the plan here\./);
  // A running plan is not progress.
  assert.equal(p.stages[p.current].id, "pr");

  const waiting = plan({ environments: ["postman_beta"], sessionId: "p-2", confirmedAt: null, confirmedBy: null, stateChanges: "POST /api/projects on Postman Beta" });
  const w = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [ev({ eventType: "deploy", environments: ["postman_beta"] }), waiting] });
  assert.equal(states(w).beta_smoketest_plan, "waiting");
  assert.equal(w.next?.id, "beta_smoketest_plan");
  assert.match(w.hint!, /waits for your confirmation\. Read it, refine it in its conversation, then confirm it\./);

  const auto = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [plan()] });
  assert.equal(states(auto).local_smoketest_plan, "done");
  assert.match(auto.stages[auto.current].detail, /accepted at once 2026-10-02: it changes no Beta or Prod state/);
  assert.equal(auto.next?.id, "local_smoketest");
  const byPiper = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [plan({ confirmedBy: "piper" })] });
  assert.match(byPiper.stages[byPiper.current].detail, /confirmed by you/);
  // A smoketest recorded by hand, with no plan, passes the plan stage too.
  assert.equal(states(sdlcProgress({ ticket: ticket(), prs: [pr()], events: [ev()] })).local_smoketest_plan, "skipped");
});

test("a later stage that is done marks the open stages before it as skipped, and the order goes on", () => {
  const p = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [ev({ eventType: "deploy", environments: ["postman_beta"], testDetails: "Checked off by hand in agent-dash" })] });
  assert.equal(states(p).local_smoketest, "skipped");
  assert.equal(states(p).in_beta, "done");
  assert.equal(p.stages[p.current].detail, "Checked off by hand in agent-dash");
  assert.equal(p.next?.id, "beta_smoketest_plan");
  assert.match(p.hint!, /Plan a smoketest on Postman Beta before you open the prod chart version update PR/);
});

test("the newest smoketest decides: a failure shows red, a later pass makes it done again", () => {
  const failed = ev({ outcome: "failed", startedAt: "2026-10-02T10:00:00.000Z" });
  const p = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [plan(), failed] });
  assert.equal(states(p).local_smoketest, "failed");
  assert.equal(p.next?.id, "local_smoketest");
  assert.match(p.hint!, /failed\. Fix it/);
  // A failure recorded by hand has no plan, so the next step is to plan one.
  assert.equal(sdlcProgress({ ticket: ticket(), prs: [pr()], events: [failed] }).next?.id, "local_smoketest_plan");
  const fixed = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [failed, ev({ startedAt: "2026-10-02T11:00:00.000Z" })] });
  assert.equal(states(fixed).local_smoketest, "done");
  // A failed smoketest is not progress, so it never marks earlier stages skipped.
  assert.equal(sdlcProgress({ ticket: ticket(), prs: [], events: [failed] }).current, 0);
});

test("a blocked smoketest is not a failure and not progress: it shows grey and stays next", () => {
  const blocked = ev({ outcome: "blocked", environments: ["postman_beta"], finishedAt: "2026-10-02T10:30:00.000Z" });
  const p = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [ev({ eventType: "deploy", environments: ["postman_beta"] }), plan({ environments: ["postman_beta"] }), blocked] });
  assert.equal(states(p).beta_smoketest, "blocked");
  assert.match(p.stages.find((s) => s.id === "beta_smoketest")!.detail, /was blocked \(2026-10-02\)/);
  assert.equal(p.next?.id, "beta_smoketest");
  assert.match(p.hint!, /was blocked\. Remove the blocker/);
  const ran = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [blocked, ev({ environments: ["postman_beta"], startedAt: "2026-10-02T11:00:00.000Z" })] });
  assert.equal(states(ran).beta_smoketest, "done");
});

test("a merged deploy PR with no confirmed deploy waits for Argo; Fern Dev counts for Beta", () => {
  const deploy = pr({ url: "https://github.com/postman-eng/cloud9-parcels-deployments/pull/7", repo: "postman-eng/cloud9-parcels-deployments", number: 7, state: "merged" });
  const p = sdlcProgress({ ticket: ticket(), prs: [pr(), deploy], events: [ev(), ev({ eventType: "review_request", environments: [], prUrl: pr().url })] });
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
  assert.equal(p.next?.id, "review_requested");
  const ran = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [skip, ev({ outcome: "failed", startedAt: "2026-10-02T11:00:00.000Z" })] });
  assert.equal(states(ran).local_smoketest, "failed");
});

test("after the local smoketest, the next stage is a review request; a posted one marks it done and names the PR", () => {
  const p = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [ev()] });
  assert.equal(p.next?.id, "review_requested");
  assert.match(p.hint!, /#proj-fern-aws-migration-devs/);
  const asked = ev({ eventType: "review_request", environments: [], outcome: null, prUrl: "https://github.com/postman-eng/cloud9-parcels-production-deployments/pull/13612", startedAt: "2026-10-05T15:10:00.000Z" });
  const done = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [ev(), asked] });
  assert.equal(states(done).review_requested, "done");
  assert.match(done.stages[done.current].detail, /cloud9-parcels-production-deployments#13612 on 2026-10-05/);
  assert.equal(done.next?.id, "in_beta");
  // A review request is not a smoketest: the local stage still shows as skipped, not done.
  assert.equal(states(sdlcProgress({ ticket: ticket(), prs: [pr()], events: [asked] })).local_smoketest, "skipped");
});

test("Done comes from Jira, and then there is no next stage", () => {
  const p = sdlcProgress({ ticket: ticket({ status: "Done", statusCategory: "done" }), prs: [pr({ state: "merged" })], events: [] });
  assert.equal(p.stages[p.current].id, "done");
  assert.equal(p.next, null);
  assert.equal(states(p).prod_smoketest, "skipped");
});

test("a smoketest with a start and no end is running: the stage is yellow until its agent records the result", () => {
  const running = ev({ outcome: null, finishedAt: null, sessionId: "s-1", startedAt: "2026-10-02T11:00:00.000Z" });
  const p = sdlcProgress({ ticket: ticket(), prs: [pr()], events: [plan(), ev({ outcome: "failed" }), running] });
  assert.equal(states(p).local_smoketest, "running");
  assert.equal(p.next?.id, "local_smoketest");
  assert.equal(p.next?.events[0].sessionId, "s-1");
  assert.match(p.hint!, /Smoketest running since 2026-10-02 11:00 UTC/);
  // A running smoketest is not progress yet.
  assert.equal(sdlcProgress({ ticket: ticket(), prs: [], events: [running] }).current, 0);
  // A hand record with no outcome has no session id, so it counts as passed.
  assert.equal(states(sdlcProgress({ ticket: ticket(), prs: [pr()], events: [ev({ finishedAt: null })] })).local_smoketest, "done");
  assert.equal(states(sdlcProgress({ ticket: ticket(), prs: [pr()], events: [ev({ outcome: null, finishedAt: null })] })).local_smoketest, "done");
});

test("an environment is an id or a label", () => {
  assert.equal(parseEnvironment("postman_beta"), "postman_beta");
  assert.equal(parseEnvironment("Postman Beta"), "postman_beta");
  assert.equal(parseEnvironment("fern-prod"), "fern_prod");
  assert.equal(parseEnvironment("staging"), null);
});

test("an event links to each ticket and environment, newest first, and a delete removes its links", () => {
  const older = db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: "2026-10-01T10:00:00.000Z", environments: ["localhost"], tickets: ["FSDK-20"] });
  const newer = db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: "2026-10-02T10:00:00.000Z", outcome: "failed", testDetails: "local FE", testResults: "500", environments: ["localhost", "postman_beta"], tickets: ["FSDK-20", "FSDK-21"] });
  const by = db.sdlcEventsByTicket();
  assert.deepEqual(by["FSDK-20"].map((e) => e.id), [newer.id, older.id]);
  assert.deepEqual(by["FSDK-21"].map((e) => e.id), [newer.id]);
  assert.deepEqual(newer.environments.sort(), ["localhost", "postman_beta"]);
  assert.equal(newer.outcome, "failed");
  assert.equal(newer.testResults, "500");
  assert.equal(db.deleteSdlcEvent(newer.id), true);
  assert.equal(db.sdlcEventsByTicket()["FSDK-21"], undefined);
  assert.equal(db.deleteSdlcEvent(newer.id), false);
  const skip = db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: "2026-10-02T12:00:00.000Z", skippedAt: "2026-10-02T12:00:00.000Z", environments: ["postman_beta"], tickets: ["FSDK-22"] });
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

test("a database from before blocked keeps its events and accepts a blocked smoketest", () => {
  const old = join(dir, "old-check.db");
  const d = new DatabaseSync(old);
  d.exec(`CREATE TABLE SDLC_Event (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL CHECK (event_type IN ('smoketest', 'deploy')), started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT CHECK (outcome IN ('passed', 'failed')), test_details TEXT, test_results TEXT, session_id TEXT, skipped_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE SDLC_Event_Ticket (id INTEGER PRIMARY KEY AUTOINCREMENT, sdlc_event_id INTEGER NOT NULL REFERENCES SDLC_Event (id), ticket TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (sdlc_event_id, ticket));
INSERT INTO SDLC_Event (id, event_type, started_at, outcome, session_id, created_at) VALUES (7, 'smoketest', '2026-10-01T10:00:00.000Z', 'failed', 's-7', '2026-10-01T10:00:00.000Z');
INSERT INTO SDLC_Event_Ticket (sdlc_event_id, ticket, created_at) VALUES (7, 'FSDK-32', '2026-10-01T10:00:00.000Z');`);
  d.close();
  const script = new URL("../scripts/sdlc-event.ts", import.meta.url).pathname;
  const out = JSON.parse(execFileSync("node", [script, "smoketest", "--ticket", "FSDK-32", "--env", "postman_beta", "--outcome", "blocked"], { env: { ...process.env, AGENT_DASH_DB: old } }).toString());
  assert.equal(out.outcome, "blocked");
  assert.equal(out.id, 8);
  const rows = new DatabaseSync(old).prepare("SELECT e.id, e.outcome FROM SDLC_Event e JOIN SDLC_Event_Ticket t ON t.sdlc_event_id = e.id WHERE t.ticket = 'FSDK-32' ORDER BY e.id").all();
  assert.deepEqual(rows.map((r) => [r.id, r.outcome]), [[7, "failed"], [8, "blocked"]]);
  const after = new DatabaseSync(old);
  assert.equal((after.prepare("SELECT session_id AS s FROM SDLC_Event WHERE id = 7").get() as { s: string }).s, "s-7");
  // A smoketest from before plans is an execution now.
  assert.equal((after.prepare("SELECT event_type AS t FROM SDLC_Event WHERE id = 7").get() as { t: string }).t, "smoketest_execution");
  // The copy drops the table's triggers, so open() must add the change trigger after it.
  assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'sdlc_event_changed'").get());
  // The same copy allows review requests, with their own columns.
  after.prepare("INSERT INTO SDLC_Event (event_type, started_at, created_at, pr_url, message) VALUES ('review_request', 't', 't', 'u', 'm')").run();
});

test("a review request has no environment, can have no ticket, and shows under its PR", () => {
  const url = "https://github.com/o/r/pull/77";
  const e = db.addSdlcEvent({ eventType: "review_request", startedAt: "2026-10-05T10:00:00.000Z", finishedAt: "2026-10-05T10:00:00.000Z", environments: [], tickets: ["FSDK-77"], prUrl: url, channel: "C1", message: `PR: fix it ${url}`, messageUrl: "https://x.slack.com/archives/C1/p1" });
  assert.deepEqual([e.eventType, e.environments, e.tickets, e.prUrl, e.channel, e.messageUrl], ["review_request", [], ["FSDK-77"], url, "C1", "https://x.slack.com/archives/C1/p1"]);
  assert.equal(e.message, `PR: fix it ${url}`);
  const none = db.addSdlcEvent({ eventType: "review_request", startedAt: "2026-10-05T11:00:00.000Z", environments: [], tickets: [], prUrl: url, message: "again" });
  assert.deepEqual(db.reviewRequestsByPr()[url].map((x) => x.id), [none.id, e.id]);
  assert.deepEqual(db.sdlcEventsByTicket()["FSDK-77"].map((x) => x.id), [e.id]);
  // Only the server posts and records review requests; the generic route cannot fake one.
  assert.throws(() => validateSdlcEvent({ eventType: "review_request", tickets: ["FSDK-1"], environments: [] }, PATTERN), /eventType/);
});

test("a new event is checked: a known type, real keys, known environments, and times in order", () => {
  const now = new Date(NOW);
  const ok = validateSdlcEvent({ eventType: "smoketest_execution", tickets: ["FSDK-1"], environments: ["Postman Beta"] }, PATTERN, now);
  assert.equal(ok.startedAt, now.toISOString());
  assert.deepEqual(ok.environments, ["postman_beta"]);
  assert.throws(() => validateSdlcEvent({ eventType: "review", tickets: ["FSDK-1"], environments: ["localhost"] }, PATTERN), /eventType/);
  // A plan comes only from the server, with the agent that writes it; "smoketest" is the script's word.
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest_plan", tickets: ["FSDK-1"], environments: ["localhost"] }, PATTERN), /eventType/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest", tickets: ["FSDK-1"], environments: ["localhost"] }, PATTERN), /eventType/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest_execution", tickets: ["FSDK-1 OR 1=1"], environments: ["localhost"] }, PATTERN), /not a ticket key/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest_execution", tickets: ["FSDK-1"], environments: ["staging"] }, PATTERN), /unknown environment/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest_execution", tickets: ["FSDK-1"], environments: [] }, PATTERN), /at least one environment/);
  const skipped = validateSdlcEvent({ eventType: "smoketest_execution", tickets: ["FSDK-1"], environments: ["localhost"], skippedAt: new Date(NOW).toISOString() }, PATTERN, now);
  assert.equal(skipped.skippedAt, now.toISOString());
  assert.throws(() => validateSdlcEvent({ eventType: "deploy", tickets: ["FSDK-1"], environments: ["localhost"], skippedAt: new Date(NOW).toISOString() }, PATTERN), /only a smoketest/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest_execution", tickets: ["FSDK-1"], environments: ["localhost"], skippedAt: new Date(NOW).toISOString(), outcome: "passed" }, PATTERN), /no outcome/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest_execution", tickets: ["FSDK-1"], environments: ["localhost"], startedAt: "2026-10-02T12:00:00Z", finishedAt: "2026-10-02T11:00:00Z" }, PATTERN), /before startedAt/);
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest_execution", tickets: ["FSDK-1"], environments: ["localhost"], summary: "x".repeat(201) }, PATTERN), /summary is longer/);
  assert.equal(validateSdlcEvent({ eventType: "smoketest_execution", tickets: ["FSDK-1"], environments: ["localhost"], outcome: "blocked" }, PATTERN, now).outcome, "blocked");
  assert.throws(() => validateSdlcEvent({ eventType: "smoketest_execution", tickets: ["FSDK-1"], environments: ["localhost"], outcome: "inconclusive" }, PATTERN), /passed, failed or blocked/);
});

test("the script that agents call writes into the same database", () => {
  const script = new URL("../scripts/sdlc-event.ts", import.meta.url).pathname;
  const results = join(dir, "results.md");
  writeFileSync(results, "All green.\n");
  const env = { ...process.env, AGENT_DASH_DB: dbPath };
  const out = JSON.parse(execFileSync("node", [script, "smoketest", "--ticket", "FSDK-30", "--env", "Postman Prod", "--outcome", "passed", "--details", "GET /health", "--results-file", results], { env }).toString());
  assert.equal(out.eventType, "smoketest_execution");
  assert.equal(db.sdlcEventsByTicket()["FSDK-30"][0].testResults, "All green.");
  assert.throws(() => execFileSync("node", [script, "smoketest", "--ticket", "FSDK-30"], { env, stdio: "pipe" }));
});

test("the agent finishes its running event once, with the script", () => {
  const script = new URL("../scripts/sdlc-event.ts", import.meta.url).pathname;
  const env = { ...process.env, AGENT_DASH_DB: dbPath };
  const running = db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: "2026-10-02T10:00:00.000Z", environments: ["localhost"], tickets: ["FSDK-31"], sessionId: "abc-123" });
  assert.equal(running.sessionId, "abc-123");
  assert.equal(running.finishedAt, null);
  const out = JSON.parse(execFileSync("node", [script, "finish", "--id", String(running.id), "--outcome", "failed", "--summary", "Publish\n500s: no token", "--results", "500 on /publish"], { env }).toString());
  assert.equal(out.outcome, "failed");
  // The summary is one line on the collapsed row.
  assert.equal(out.summary, "Publish 500s: no token");
  assert.ok(out.finishedAt);
  const saved = db.sdlcEventsByTicket()["FSDK-31"][0];
  assert.equal(saved.testResults, "500 on /publish");
  assert.equal(saved.sessionId, "abc-123");
  // A second result does not overwrite the first, and a result needs an outcome.
  assert.throws(() => execFileSync("node", [script, "finish", "--id", String(running.id), "--outcome", "passed"], { env, stdio: "pipe" }));
  const other = db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: "2026-10-02T10:00:00.000Z", environments: ["localhost"], tickets: ["FSDK-31"] });
  assert.throws(() => execFileSync("node", [script, "finish", "--id", String(other.id)], { env, stdio: "pipe" }));
  assert.throws(() => execFileSync("node", [script, "finish", "--id", "999999", "--outcome", "passed"], { env, stdio: "pipe" }));
  assert.throws(() => execFileSync("node", [script, "finish", "--outcome", "passed"], { env, stdio: "pipe" }));
  const deploy = db.addSdlcEvent({ eventType: "deploy", startedAt: "2026-10-02T10:00:00.000Z", environments: ["postman_beta"], tickets: ["FSDK-31"] });
  assert.throws(() => execFileSync("node", [script, "finish", "--id", String(deploy.id), "--outcome", "passed"], { env, stdio: "pipe" }));
});

test("verb messages name the environment and the record command; the summary prompt carries the order", async () => {
  const m = planMessage("FSDK-1", "localhost", "/dash/scripts/sdlc-event.ts", 12);
  assert.match(m, /^Plan a smoketest of FSDK-1 on localhost\. Write the plan only: do not run the test yet\./);
  assert.match(m, /Local smoketesting\.md/);
  assert.match(m, /node \/dash\/scripts\/sdlc-event\.ts plan --id 12 --summary "<plan summary>" --plan-file <file> --state-changes none/);
  assert.match(m, /--writes-summary "<writes summary>" --plan-file <file> --state-changes-file <file>/);
  assert.match(m, /--state-changes-file <file>/);
  assert.match(m, /change no state on Postman Beta, Postman Prod, Fern Dev and Fern Prod/);
  assert.match(planMessage("FSDK-1", "postman_prod", "/s", 1), /real customer traffic/);
  const confirmed = plan({ id: 40, confirmedBy: "piper", stateChanges: "POST /api/projects on Postman Beta", testDetails: "1. Create a project." });
  const run = executeMessage("FSDK-1", "postman_beta", "/s", 41, confirmed);
  assert.match(run, /Piper confirmed the smoketest plan of FSDK-1 on Postman Beta \(SDLC event 40, the version recorded at 2026-10-02T09:10:00\.000Z\)/);
  assert.match(run, /approval to make the state changes that the plan lists, and only those:\nPOST \/api\/projects on Postman Beta/);
  assert.match(run, /<plan>\n1\. Create a project\.\n<\/plan>/);
  assert.match(run, /node \/s finish --id 41 --outcome passed\|failed\|blocked/);
  const auto = executeMessage("FSDK-1", "localhost", "/s", 42, plan({ id: 39 }));
  assert.match(auto, /accepted the smoketest plan of FSDK-1 on localhost \(SDLC event 39\), because it changes no state/);
  assert.doesNotMatch(auto, /<plan>/);
  assert.match(run, /--summary "<one line>"/);
  const c = confirmDeployMessage("FSDK-1", "beta", ["https://github.com/postman-eng/cloud9-parcels-deployments/pull/7"], "/s");
  assert.match(c, /Do not sync, roll back, or change anything/);
  assert.match(c, /deploy --ticket FSDK-1 --env postman_beta/);

  assert.match(buildPrompt("FSDK-1", 1, "/w"), /local smoketest comes before a PR review request/);
  assert.match(buildPrompt("FSDK-1", 1, "/w"), /Each smoketest starts with a plan/);
  const ctx = await buildContext({ ticket: ticket(), runs: [], prs: [pr()], events: [], ticketPrs: [] });
  assert.match(ctx, /## SDLC progress of FSDK-1/);
  assert.match(ctx, /Next stage: Local test plan\./);
  const handoff = buildHandoff({ group: { ticket: ticket(), runs: [], prs: [pr()], threads: {} }, notes: [], summary: undefined, events: [ev()], now: new Date(NOW) });
  assert.match(handoff, /\[x\] Local smoketest/);
});

test("a new event starts one next-steps draft per ticket on the board, and replaces a draft that started before it", () => {
  db.claimNewEventTickets(); // the events of the tests above
  db.createRequest("FSDK-40", new Date(Date.now() - 60_000));
  db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: "2026-10-02T10:00:00.000Z", environments: ["localhost"], tickets: ["FSDK-40", "FSDK-41"] });
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

test("a running smoketest starts its next-steps draft when it finishes, not when it starts", () => {
  db.claimNewEventTickets();
  const e = db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: new Date().toISOString(), environments: ["localhost"], tickets: ["FSDK-42"], sessionId: "s-42" });
  assert.equal(db.hasNewEventTickets(), false);
  db.finishSdlcEvent(e.id, { finishedAt: new Date().toISOString(), outcome: "passed", testDetails: null, testResults: null });
  assert.deepEqual([...db.claimNewEventTickets().keys()], ["FSDK-42"]);
});

test("a skipped smoketest cannot be finished", () => {
  const now = new Date().toISOString();
  const e = db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: now, skippedAt: now, environments: ["localhost"], tickets: ["FSDK-43"] });
  assert.equal(db.finishSdlcEvent(e.id, { finishedAt: now, outcome: "passed", testDetails: null, testResults: null }), null);
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

test("a changed event starts a new draft for each of its tickets, from any writer, and replaces a draft that started before the change", () => {
  const e = db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: "2026-10-02T10:00:00.000Z", environments: ["localhost"], tickets: ["FSDK-60", "FSDK-61"] });
  db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: "2026-10-02T10:00:00.000Z", environments: ["localhost"], tickets: ["FSDK-62"] });
  db.claimNewEventTickets();
  db.createRequest("FSDK-60", new Date(Date.now() - 60_000));
  // Another connection, as the script's own process would write.
  new DatabaseSync(dbPath).prepare("UPDATE SDLC_Event SET outcome = 'passed', finished_at = ? WHERE id = ?").run(new Date().toISOString(), e.id);
  assert.equal(db.hasNewEventTickets(), true);
  const calls: { key: string; force?: boolean }[] = [];
  const start = async (g: { ticket: { key: string } }, opts?: { force?: boolean }) => (calls.push({ key: g.ticket.key, force: opts?.force }), {} as db.SummaryRecord);
  const groups = ["FSDK-60", "FSDK-61", "FSDK-62"].map((key) => ({ ticket: ticket({ key }), runs: [], prs: [] }));
  assert.deepEqual(redraftAfterNewEvents(groups, undefined, start), ["FSDK-60", "FSDK-61"]);
  assert.deepEqual(calls, [{ key: "FSDK-60", force: true }, { key: "FSDK-61", force: false }]);
  assert.equal(db.hasNewEventTickets(), false);
});

test("a database from before plans renames its smoketests, keeps their ids, and starts no paid drafts", () => {
  const old = join(dir, "old-plans.db");
  const d = new DatabaseSync(old);
  d.exec(`CREATE TABLE SDLC_Event (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL CHECK (event_type IN ('smoketest', 'deploy', 'review_request')), started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT CHECK (outcome IN ('passed', 'failed', 'blocked')), test_details TEXT, test_results TEXT, session_id TEXT, skipped_at TEXT, created_at TEXT NOT NULL, pr_url TEXT, channel TEXT, message TEXT, message_url TEXT);
CREATE TABLE SDLC_Event_Ticket (id INTEGER PRIMARY KEY AUTOINCREMENT, sdlc_event_id INTEGER NOT NULL REFERENCES SDLC_Event (id), ticket TEXT NOT NULL, created_at TEXT NOT NULL, summary_requested_at TEXT, changed_at TEXT, UNIQUE (sdlc_event_id, ticket));
INSERT INTO SDLC_Event (id, event_type, started_at, outcome, created_at) VALUES (3, 'smoketest', '2026-10-01T10:00:00.000Z', 'passed', 't'), (4, 'deploy', '2026-10-01T11:00:00.000Z', NULL, 't');
INSERT INTO SDLC_Event_Ticket (sdlc_event_id, ticket, created_at, summary_requested_at) VALUES (3, 'FSDK-90', 't', 't'), (4, 'FSDK-90', 't', 't');`);
  d.close();
  const script = new URL("../scripts/sdlc-event.ts", import.meta.url).pathname;
  execFileSync("node", [script, "deploy", "--ticket", "FSDK-91", "--env", "postman_beta"], { env: { ...process.env, AGENT_DASH_DB: old } });
  const after = new DatabaseSync(old);
  assert.deepEqual(after.prepare("SELECT id, event_type AS t FROM SDLC_Event WHERE id IN (3, 4) ORDER BY id").all().map((r) => [r.id, r.t]), [[3, "smoketest_execution"], [4, "deploy"]]);
  // The rename is in the copy, not an UPDATE, so the change trigger does not ask for a draft per ticket.
  assert.equal(after.prepare("SELECT count(*) AS n FROM SDLC_Event_Ticket WHERE ticket = 'FSDK-90' AND summary_requested_at IS NULL").get()!.n, 0);
  assert.throws(() => after.prepare("INSERT INTO SDLC_Event (event_type, started_at, created_at) VALUES ('smoketest', 't', 't')").run(), /CHECK/);
  assert.throws(() => after.prepare("INSERT INTO SDLC_Event (event_type, started_at, created_at, confirmed_by) VALUES ('smoketest_plan', 't', 't', 'someone')").run(), /CHECK/);
});

test("a plan with no Beta or Prod state changes is accepted when it is recorded; any other waits for Piper's exact version", () => {
  const p = db.addSdlcEvent({ eventType: "smoketest_plan", startedAt: new Date().toISOString(), environments: ["postman_beta"], tickets: ["FSDK-70"], sessionId: "plan-70" });
  assert.equal(p.plannedAt, null);
  const v1 = db.recordPlan(p.id, { plan: "1. Create a project", stateChanges: "POST /projects on Beta", plannedAt: "2026-10-05T10:00:00.000Z" })!;
  assert.deepEqual([v1.testDetails, v1.stateChanges, v1.confirmedAt], ["1. Create a project", "POST /projects on Beta", null]);
  const v2 = db.recordPlan(p.id, { plan: "1. Create a project\n2. Delete it", stateChanges: "POST and DELETE /projects on Beta", plannedAt: "2026-10-05T10:05:00.000Z" })!;
  // Piper confirmed the version the page showed before the agent changed it: refused.
  assert.equal(db.confirmPlan(p.id, v1.plannedAt!), null);
  const ok = db.confirmPlan(p.id, v2.plannedAt!)!;
  assert.deepEqual([ok.confirmedBy, !!ok.confirmedAt], ["piper", true]);
  assert.equal(db.confirmPlan(p.id, v2.plannedAt!), null);
  // A confirmed plan is frozen: the approval is for that text.
  assert.equal(db.recordPlan(p.id, { plan: "other", stateChanges: null, plannedAt: "2026-10-05T10:10:00.000Z" }), null);
  db.unconfirmPlan(p.id);
  assert.equal(db.getSdlcEvent(p.id)!.confirmedAt, null);

  const local = db.addSdlcEvent({ eventType: "smoketest_plan", startedAt: new Date().toISOString(), environments: ["localhost"], tickets: ["FSDK-70"], sessionId: "plan-71" });
  const auto = db.recordPlan(local.id, { plan: "1. pnpm dev", stateChanges: null, plannedAt: "2026-10-05T11:00:00.000Z" })!;
  assert.deepEqual([auto.confirmedBy, auto.confirmedAt], ["auto", "2026-10-05T11:00:00.000Z"]);
  // A deploy is not a plan.
  const deploy = db.addSdlcEvent({ eventType: "deploy", startedAt: new Date().toISOString(), environments: ["postman_beta"], tickets: ["FSDK-70"] });
  assert.equal(db.recordPlan(deploy.id, { plan: "x", stateChanges: null, plannedAt: "t" }), null);
});

test("a plan's changes start no next-steps draft; the run's result does", () => {
  db.claimNewEventTickets();
  const p = db.addSdlcEvent({ eventType: "smoketest_plan", startedAt: new Date().toISOString(), environments: ["localhost"], tickets: ["FSDK-71"], sessionId: "plan-72" });
  db.recordPlan(p.id, { plan: "1. pnpm dev", stateChanges: "x", plannedAt: new Date().toISOString() });
  db.confirmPlan(p.id, db.getSdlcEvent(p.id)!.plannedAt!);
  assert.equal(db.hasNewEventTickets(), false);
});

test("the plan text and the state changes are checked; none means no state change", () => {
  const s = { summary: "Load the page" };
  assert.equal(validateSdlcPlan({ plan: "x", stateChanges: "None", ...s }).stateChanges, null);
  assert.equal(validateSdlcPlan({ plan: "x", stateChanges: "", ...s }).stateChanges, null);
  const beta = validateSdlcPlan({ plan: "x", stateChanges: "POST /a on Beta\n", summary: " Load the page ", writesSummary: "Postman Beta: one project" });
  assert.deepEqual([beta.stateChanges, beta.summary, beta.writesSummary], ["POST /a on Beta", "Load the page", "Postman Beta: one project"]);
  assert.throws(() => validateSdlcPlan({ plan: " ", stateChanges: "none", ...s }), /empty/);
  assert.throws(() => validateSdlcPlan({ plan: "x", ...s }), /none/);
  // Piper reads the summaries first, so a plan without them is refused.
  assert.throws(() => validateSdlcPlan({ plan: "x", stateChanges: "none" }), /--summary/);
  assert.throws(() => validateSdlcPlan({ plan: "x", stateChanges: "POST /a on Beta", ...s }), /--writes-summary/);
  // With no state changes there is nothing to summarise.
  assert.equal(validateSdlcPlan({ plan: "x", stateChanges: "none", writesSummary: "y", ...s }).writesSummary, null);
});

test("the agent records its plan with the script: no state changes runs at once, with the plan's session; others wait", () => {
  const script = new URL("../scripts/sdlc-event.ts", import.meta.url).pathname;
  const env = { ...process.env, AGENT_DASH_DB: dbPath };
  const planFile = join(dir, "plan.md");
  writeFileSync(planFile, "1. Open the docs page.\n");
  const local = db.addSdlcEvent({ eventType: "smoketest_plan", startedAt: new Date().toISOString(), environments: ["localhost"], tickets: ["FSDK-72"], sessionId: "plan-73" });
  const out = execFileSync("node", [script, "plan", "--id", String(local.id), "--summary", "Open the docs page", "--plan-file", planFile, "--state-changes", "none"], { env }).toString();
  const run = db.sdlcEventsByTicket()["FSDK-72"].find((e) => e.eventType === "smoketest_execution")!;
  assert.deepEqual([run.planId, run.sessionId, run.finishedAt], [local.id, "plan-73", null]);
  assert.match(out, new RegExp(`because it changes no state[\\s\\S]*finish --id ${run.id} `));
  assert.deepEqual([db.getSdlcEvent(local.id)!.testDetails, db.getSdlcEvent(local.id)!.summary], ["1. Open the docs page.", "Open the docs page"]);

  const changes = join(dir, "changes.md");
  writeFileSync(changes, "POST /api/projects on Postman Beta\n");
  const beta = db.addSdlcEvent({ eventType: "smoketest_plan", startedAt: new Date().toISOString(), environments: ["postman_beta"], tickets: ["FSDK-73"], sessionId: "plan-74" });
  const wait = execFileSync("node", [script, "plan", "--id", String(beta.id), "--summary", "Make a project", "--writes-summary", "Postman Beta: one project", "--plan-file", planFile, "--state-changes-file", changes], { env }).toString();
  assert.match(wait, /waits for Piper's confirmation/);
  assert.equal(db.getSdlcEvent(beta.id)!.writesSummary, "Postman Beta: one project");
  assert.equal(db.sdlcEventsByTicket()["FSDK-73"].filter((e) => e.eventType === "smoketest_execution").length, 0);
  // No state changes named at all is refused, and so is a plan that is already accepted.
  assert.throws(() => execFileSync("node", [script, "plan", "--id", String(beta.id), "--plan-file", planFile], { env, stdio: "pipe" }));
  assert.throws(() => execFileSync("node", [script, "plan", "--id", String(local.id), "--plan-file", planFile, "--state-changes", "none"], { env, stdio: "pipe" }));
});

test("a deleted plan leaves its run, without the link", () => {
  const p = db.addSdlcEvent({ eventType: "smoketest_plan", startedAt: new Date().toISOString(), environments: ["localhost"], tickets: ["FSDK-74"], sessionId: "plan-75" });
  const run = db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: new Date().toISOString(), environments: ["localhost"], tickets: ["FSDK-74"], planId: p.id });
  assert.equal(db.deleteSdlcEvent(p.id), true);
  assert.equal(db.getSdlcEvent(run.id)!.planId, null);
});
