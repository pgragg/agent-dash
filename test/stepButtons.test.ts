import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestStepLabels, topSteps } from "../server/stepButtons.ts";
import * as db from "../server/summaries/db.ts";
import { cleanLabel, stepLabelPrompt } from "../shared/stepButton.ts";
import type { Dashboard, NextStep } from "../shared/types.ts";
import { ticket } from "./helpers.ts";

db.open(join(mkdtempSync(join(tmpdir(), "agent-dash-step-button-")), "test.db"));

const summaries = (): Dashboard["summaries"] => Object.fromEntries([...db.summariesByTicket()].map(([k, v]) => [k, v]));
const group = (key: string, statusCategory: "new" | "indeterminate" | "done" = "indeterminate") => ({ ticket: ticket({ key, statusCategory }), runs: [], prs: [], items: [] }) as never;

function draftFor(key: string, steps: string[]): void {
  const rec = db.createRequest(key);
  db.markDone(rec.id, `**State:** x\n\n**Next steps:**\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
}

test("the model's label is cleaned to one short line", () => {
  assert.equal(cleanLabel('"Open prod parcel bump PR."\n\nThis step…'), "Open prod parcel bump PR");
  assert.equal(cleanLabel("- Label: Run Beta smoketest"), "Run Beta smoketest");
  assert.equal(cleanLabel("**Start ticket**"), "Start ticket");
  assert.equal(cleanLabel("Based on the step description, the button label is:\n\nAgent opens the prod chart bump PR"), "Agent opens the prod chart bump PR");
  assert.equal(cleanLabel("\n\n"), null);
  assert.equal(cleanLabel("x".repeat(80))!.length, 60);
  const prompt = stepLabelPrompt("FSDK-1", "s".repeat(5_000));
  assert.match(prompt, /ticket FSDK-1/);
  assert.ok(prompt.length < 3_500);
});

test("only the top step of each open ticket's newest finished draft gets a label", () => {
  draftFor("FSDK-10", ["old first step"]);
  draftFor("FSDK-10", ["new first step", "second step"]);
  draftFor("FSDK-11", ["closed ticket step"]);
  db.createRequest("FSDK-12");
  const steps = topSteps([group("FSDK-10"), group("FSDK-11", "done"), group("FSDK-12"), group("FSDK-13")], summaries());
  assert.deepEqual(steps.map((s) => s.body), ["new first step"]);
  const prompt = stepLabelPrompt("FSDK-10", "Piper moves the ticket to In Review");
  assert.match(prompt, /starts with "Agent"/);
  assert.match(prompt, /Move ticket to <status>/);
});

test("each label is drafted once; a failure is tried again only later; a new draft's top step gets its own label", async () => {
  draftFor("FSDK-20", ["Piper starts the ticket"]);
  draftFor("FSDK-21", ["An agent opens the prod parcel bump PR"]);
  const groups = [group("FSDK-20"), group("FSDK-21")];
  let changes = 0;
  const draft = async (s: NextStep) => {
    await new Promise((r) => setTimeout(r, 5));
    if (s.ticket === "FSDK-21") throw new Error("pi exited with code 1");
    return "Start ticket";
  };
  const now = new Date("2026-10-08T10:00:00.000Z");
  assert.equal(requestStepLabels(topSteps(groups, summaries()), () => changes++, draft, now).length, 2);
  // A second page load while they run starts nothing.
  assert.deepEqual(requestStepLabels(topSteps(groups, summaries()), () => changes++, draft, now), []);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(changes, 2);
  assert.equal(summaries()["FSDK-20"].latest.steps[0].label, "Start ticket");
  assert.equal(summaries()["FSDK-21"].latest.steps[0].label, null);
  // A labelled step is not drafted again; the failed one waits for the retry time.
  assert.deepEqual(requestStepLabels(topSteps(groups, summaries()), () => {}, draft, new Date("2026-10-08T10:01:00.000Z")), []);
  const retried = requestStepLabels(topSteps(groups, summaries()), () => {}, draft, new Date("2026-10-08T10:06:00.000Z"));
  assert.deepEqual(retried, [summaries()["FSDK-21"].latest.steps[0].id]);

  draftFor("FSDK-20", ["Piper moves the ticket to In Review"]);
  const [next] = topSteps(groups, summaries());
  assert.equal(next.body, "Piper moves the ticket to In Review");
  requestStepLabels([next], () => {}, async () => "Move to In Review", now);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(summaries()["FSDK-20"].latest.steps[0].label, "Move to In Review");
});

test("a label from an older prompt is drafted again, and a failed redraft keeps the old label", async () => {
  draftFor("FSDK-30", ["An agent opens the prod parcel bump PR"]);
  const [step] = topSteps([group("FSDK-30")], summaries());
  const now = new Date("2026-10-08T10:00:00.000Z");
  assert.deepEqual(db.claimStepLabels([step.id], 1, now.toISOString(), now), [step.id]);
  db.finishStepLabel(step.id, "Open prod parcel bump PR");
  assert.deepEqual(db.claimStepLabels([step.id], 1, now.toISOString(), now), []);
  assert.equal(requestStepLabels([step], () => {}, async () => { throw new Error("down"); }, now).length, 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(summaries()["FSDK-30"].latest.steps[0].label, "Open prod parcel bump PR");
  // The failed redraft counts as a try of the new prompt, so it waits for the retry time.
  assert.deepEqual(requestStepLabels([step], () => {}, async () => "x", new Date("2026-10-08T10:01:00.000Z")), []);
  assert.equal(requestStepLabels([step], () => {}, async () => "Agent opens prod parcel bump PR", new Date("2026-10-08T10:06:00.000Z")).length, 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(summaries()["FSDK-30"].latest.steps[0].label, "Agent opens prod parcel bump PR");
});
