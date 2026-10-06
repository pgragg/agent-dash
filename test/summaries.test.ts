import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as db from "../server/summaries/db.ts";
import { buildContext, buildPrompt, finish } from "../server/summaries/runner.ts";
import { digestSession } from "../server/sources/sessions.ts";
import { header, jsonl, reply, run, ticket, toolCall, toolResult, user } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-dash-test-"));
const dbPath = join(dir, "test.db");
db.open(dbPath);

test("a request starts in progress; saving sets the summary and generated_at once", () => {
  const rec = db.createRequest("FSDK-1", new Date("2026-10-02T12:00:00Z"));
  assert.equal(rec.status, "in_progress");
  assert.equal(rec.requestedAt, "2026-10-02T12:00:00.000Z");
  assert.equal(rec.generatedAt, null);
  assert.equal(db.markDone(rec.id, "**State:** fine", new Date("2026-10-02T12:03:00Z")), true);
  const done = db.get(rec.id)!;
  assert.equal(done.status, "done");
  assert.equal(done.generatedAt, "2026-10-02T12:03:00.000Z");
  // A late writer cannot overwrite a finished request.
  assert.equal(db.markDone(rec.id, "late"), false);
  assert.equal(db.markFailed(rec.id, "late"), false);
});

test("per ticket: the newest request, and the newest finished summary to show meanwhile", () => {
  const a = db.createRequest("FSDK-2");
  db.markDone(a.id, "old summary");
  const b = db.createRequest("FSDK-2");
  const state = db.summariesByTicket().get("FSDK-2")!;
  assert.equal(state.latest.id, b.id);
  assert.equal(state.latest.status, "in_progress");
  assert.equal(state.lastDone?.summary, "old summary");
});

test("the save script that the pi run calls writes into the same database", () => {
  const rec = db.createRequest("FSDK-3");
  const script = new URL("../scripts/save-summary.ts", import.meta.url).pathname;
  const out = execFileSync("node", [script, String(rec.id)], { input: "**State:** saved by script\n", env: { ...process.env, AGENT_DASH_DB: dbPath } }).toString();
  assert.match(out, /saved summary/);
  assert.equal(db.get(rec.id)!.summary, "**State:** saved by script");
  assert.throws(() => execFileSync("node", [script, String(rec.id)], { input: "again", env: { ...process.env, AGENT_DASH_DB: dbPath }, stdio: "pipe" }));
});

test("a run that ended without saving: its last reply counts, an empty one fails", () => {
  const ok = db.createRequest("FSDK-4");
  const okDir = mkdtempSync(join(dir, "ok-"));
  writeFileSync(join(okDir, "out.log"), "\x1b]1;title\x07**State:** the run printed this summary instead of saving it.\n");
  db.setProcess(ok.id, 999999, okDir);
  finish(ok.id, 0);
  assert.equal(db.get(ok.id)!.status, "done");
  assert.equal(db.get(ok.id)!.summary, "**State:** the run printed this summary instead of saving it.");

  const bad = db.createRequest("FSDK-4");
  const badDir = mkdtempSync(join(dir, "bad-"));
  writeFileSync(join(badDir, "out.log"), "");
  writeFileSync(join(badDir, "err.log"), "Error: model not found\n");
  db.setProcess(bad.id, 999999, badDir);
  finish(bad.id, 1);
  assert.equal(db.get(bad.id)!.status, "failed");
  assert.match(db.get(bad.id)!.error!, /code 1.*model not found/s);
});

test("a session digest keeps prompts and replies, drops tool output, and keeps the newest part", () => {
  const raw = jsonl(header(), user("fix FSDK-9"), toolCall("t1", "cat big.log"), toolResult("t1", "SECRET TOOL OUTPUT"), reply("Fixed it."));
  const d = digestSession(raw, 10_000);
  assert.match(d, /USER .*fix FSDK-9/);
  assert.match(d, /AGENT .*Fixed it\./);
  assert.doesNotMatch(d, /SECRET TOOL OUTPUT/);
  const cut = digestSession(raw, 30);
  assert.match(cut, /earlier turns cut/);
  assert.match(cut, /Fixed it\.$/);
});

test("the prompt is read-only and names the save command for this request", () => {
  const p = buildPrompt("FSDK-5", 42, "/w");
  assert.match(p, /Read-only/);
  assert.match(p, /save-summary\.ts 42 < \/w\/summary\.md/);
  assert.match(p, /jira issue view FSDK-5/);
  assert.match(p, /slack-search\.ts "FSDK-5"/);
});

test("notes are saved per ticket with a timestamp, oldest first, and can be deleted", () => {
  const a = db.addNote("FSDK-7", "first", new Date("2026-10-02T10:00:00Z"));
  const b = db.addNote("FSDK-7", "second", new Date("2026-10-02T11:00:00Z"));
  db.addNote("FSDK-8", "other ticket");
  assert.deepEqual(db.notesForTicket("FSDK-7").map((n) => [n.body, n.createdAt]), [["first", "2026-10-02T10:00:00.000Z"], ["second", "2026-10-02T11:00:00.000Z"]]);
  assert.equal(db.notesByTicket()["FSDK-8"].length, 1);
  assert.equal(db.deleteNote(a.id), true);
  assert.deepEqual(db.notesForTicket("FSDK-7").map((n) => n.id), [b.id]);
  assert.equal(db.deleteNote(a.id), false);
});

test("a summary run gets the notes, with their times, ahead of the other sources", async () => {
  const notes = [{ id: 1, ticket: "FSDK-9", createdAt: "2026-10-02T10:00:00.000Z", body: "Arie said: wait for the cutover.\nThen merge." }];
  const ctx = await buildContext({ ticket: ticket({ key: "FSDK-9" }), runs: [], prs: [], notes });
  assert.match(ctx, /private notes on FSDK-9/);
  assert.match(ctx, /- \[2026-10-02T10:00:00.000Z\] Arie said: wait for the cutover.\n  Then merge./);
  assert.ok(ctx.indexOf("private notes") < ctx.indexOf("## PRs"));
  assert.match(buildPrompt("FSDK-9", 1, "/w"), /private notes/);
});

test("thread status is append-only; the newest change wins, and only 'resolved' keeps a reason", () => {
  db.setThreadStatus("FSDK-10", "sess-0001", "resolved", "duplicate of another run", new Date("2026-10-02T10:00:00Z"));
  db.setThreadStatus("FSDK-10", "sess-0001", "relevant", "ignored", new Date("2026-10-02T10:05:00Z"));
  db.setThreadStatus("FSDK-10", "sess-0002", "resolved", null);
  const now = db.currentThreadStatuses().filter((t) => t.ticket === "FSDK-10");
  assert.deepEqual(now.map((t) => [t.sessionId, t.status, t.reason]).sort(), [["sess-0001", "relevant", null], ["sess-0002", "resolved", null]]);
  assert.deepEqual(db.threadHistory("FSDK-10", "sess-0001").map((t) => [t.status, t.reason]), [["resolved", "duplicate of another run"], ["relevant", null]]);
});

test("a summary run sees resolved threads by name and reason only, not their history", async () => {
  const runFile = join(dir, "resolved.jsonl");
  writeFileSync(runFile, jsonl(header(), user("OLD PLAN that no longer applies"), reply("ok")));
  const r = run({ sessionId: "gone", name: "Old approach", sessionFile: runFile, tickets: ["FSDK-11"] });
  const threads = { gone: { id: 1, ticket: "FSDK-11", sessionId: "gone", status: "resolved" as const, reason: "approach dropped", createdAt: "2026-10-02T10:00:00.000Z" } };
  const ctx = await buildContext({ ticket: ticket({ key: "FSDK-11" }), runs: [r], prs: [], threads });
  assert.match(ctx, /marked resolved for FSDK-11/);
  assert.match(ctx, /- Old approach \(resolved 2026-10-02T10:00:00.000Z: approach dropped\)/);
  assert.doesNotMatch(ctx, /OLD PLAN/);
  assert.match(ctx, /Agent sessions about FSDK-11 \(0,/);
});

test("saving a summary stores each next step as its own row", () => {
  const rec = db.createRequest("FSDK-9");
  db.markDone(rec.id, "**State:** x\n\n**Next steps:**\n1. Piper: decide.\n2. An agent: fix it.\n\n**Blockers:** none.");
  const steps = db.get(rec.id)!.steps;
  assert.deepEqual(
    steps.map((s) => [s.position, s.body, s.ticket, s.summaryId]),
    [
      [1, "Piper: decide.", "FSDK-9", rec.id],
      [2, "An agent: fix it.", "FSDK-9", rec.id],
    ],
  );
  assert.deepEqual(db.getStep(steps[1].id), steps[1]);
  assert.equal(db.summariesByTicket().get("FSDK-9")!.lastDone!.steps.length, 2);
  // A late save neither changes the summary nor adds steps.
  db.markDone(rec.id, "**Next steps:**\n1. late");
  assert.equal(db.get(rec.id)!.steps.length, 2);
});

test("a ticket's snoozedUntil is saved, replaced, and cleared", () => {
  db.setSnoozedUntil("FSDK-20", new Date("2026-10-05T09:00:00Z"));
  db.setSnoozedUntil("FSDK-20", new Date("2026-10-06T09:00:00Z"));
  db.setSnoozedUntil("FSDK-21", new Date("2026-10-07T09:00:00Z"));
  assert.equal(db.snoozedUntilByTicket()["FSDK-20"], "2026-10-06T09:00:00.000Z");
  db.setSnoozedUntil("FSDK-21", null);
  assert.equal("FSDK-21" in db.snoozedUntilByTicket(), false);
});

test("a star is saved and cleared, and does not touch the snooze", () => {
  db.setStarred("FSDK-20", true);
  db.setStarred("FSDK-22", true);
  assert.deepEqual(db.starredTickets(), ["FSDK-20", "FSDK-22"]);
  assert.equal(db.snoozedUntilByTicket()["FSDK-20"], "2026-10-06T09:00:00.000Z");
  db.setStarred("FSDK-20", false);
  assert.deepEqual(db.starredTickets(), ["FSDK-22"]);
});
