import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as db from "../server/summaries/db.ts";
import { buildPrompt, finish } from "../server/summaries/runner.ts";
import { digestSession } from "../server/sources/sessions.ts";
import { header, jsonl, reply, toolCall, toolResult, user } from "./helpers.ts";

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
