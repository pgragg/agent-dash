import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stepMessage } from "../server/handoff.ts";
import { type LabelDeps, requestStepLabels, topSteps } from "../server/stepButtons.ts";
import * as db from "../server/summaries/db.ts";
import { cleanLabel, describeAction, stepLabelPrompt } from "../shared/stepButton.ts";
import type { Dashboard, TicketDetail } from "../shared/types.ts";
import { ticket } from "./helpers.ts";

db.open(join(mkdtempSync(join(tmpdir(), "agent-dash-step-button-")), "test.db"));

const summaries = (): Dashboard["summaries"] => Object.fromEntries([...db.summariesByTicket()].map(([k, v]) => [k, v]));
const top = (key: string) => summaries()[key].latest.steps[0];
const source = (move: boolean) => ({ id: "jira", label: "Jira", dueDate: true, move });
const group = (key: string, o: { statusCategory?: "new" | "indeterminate" | "done"; move?: boolean } = {}) =>
  ({ ticket: ticket({ key, statusCategory: o.statusCategory ?? "indeterminate", source: source(o.move ?? false) }), runs: [], prs: [], items: [] }) as never;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function draftFor(key: string, steps: string[]): void {
  const rec = db.createRequest(key);
  db.markDone(rec.id, `**State:** x\n\n**Next steps:**\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
}

const noDetail = async (): Promise<TicketDetail | null> => null;
const deps = (draft: LabelDeps["draft"], detail: LabelDeps["detail"] = noDetail): LabelDeps => ({ draft, detail });

test("the model's label is cleaned to one short line", () => {
  assert.equal(cleanLabel('"Agent opens prod parcel bump PR."\n\nThis step…'), "Agent opens prod parcel bump PR");
  assert.equal(cleanLabel("- Label: Agent re-runs the Beta smoketest"), "Agent re-runs the Beta smoketest");
  assert.equal(cleanLabel("Based on the step description, the button label is:\n\nAgent opens the prod chart bump PR"), "Agent opens the prod chart bump PR");
  assert.equal(cleanLabel("\n\n"), null);
  assert.equal(cleanLabel("x".repeat(80))!.length, 60);
});

test("the prompt holds the request the button sends and the agent's exact first message", () => {
  const message = stepMessage("FSDK-1", "An agent opens the prod parcel bump PR");
  const prompt = stepLabelPrompt("FSDK-1", 42, message);
  assert.match(prompt, /POST \/api\/agents\?ticket=FSDK-1` with `\{"step": 42\}`/);
  assert.ok(prompt.includes(message));
  assert.ok(stepLabelPrompt("FSDK-1", 42, "m".repeat(5_000)).length < 4_000);
  assert.match(describeAction("FSDK-1", { kind: "agent", message }, "~/repo"), /starts an agent in ~\/repo[\s\S]*Do this next step on FSDK-1/);
  assert.equal(describeAction("FSDK-1", { kind: "move", to: "In Review" }, "~"), 'A click moves FSDK-1 to "In Review" in its tracker.');
});

test("only the top step of each open ticket's newest finished draft is a candidate", () => {
  draftFor("FSDK-10", ["old first step"]);
  draftFor("FSDK-10", ["new first step", "second step"]);
  draftFor("FSDK-11", ["closed ticket step"]);
  db.createRequest("FSDK-12");
  const tops = topSteps([group("FSDK-10"), group("FSDK-11", { statusCategory: "done" }), group("FSDK-12"), group("FSDK-13")], summaries());
  assert.deepEqual(tops.map((t) => t.step.body), ["new first step"]);
});

test("the label is written from the action, which the step keeps for the click", async () => {
  draftFor("FSDK-20", ["An agent opens the prod parcel bump PR"]);
  const seen: string[] = [];
  const now = new Date("2026-10-08T10:00:00.000Z");
  requestStepLabels(topSteps([group("FSDK-20")], summaries()), () => {}, deps(async (_s, message) => (seen.push(message), "Agent opens prod parcel bump PR")), now);
  await wait(10);
  const message = stepMessage("FSDK-20", "An agent opens the prod parcel bump PR");
  assert.deepEqual(seen, [message]);
  assert.equal(top("FSDK-20").label, "Agent opens prod parcel bump PR");
  assert.deepEqual(top("FSDK-20").action, { kind: "agent", message });
});

test("a step that only moves the ticket is a move, with no model; a move the tracker cannot make is an agent", async () => {
  draftFor("FSDK-21", ["Piper moves the ticket to In Review"]);
  draftFor("FSDK-22", ["Piper moves the ticket to Shipped"]);
  const detail = async (): Promise<TicketDetail> => ({ status: "In Progress", transitions: [{ id: "1", name: "Review", to: "In Review" }] }) as never;
  let drafts = 0;
  const now = new Date("2026-10-08T10:00:00.000Z");
  requestStepLabels(topSteps([group("FSDK-21", { move: true }), group("FSDK-22", { move: true })], summaries()), () => {}, deps(async () => (drafts++, "Agent moves it"), detail), now);
  await wait(10);
  assert.deepEqual(top("FSDK-21").action, { kind: "move", to: "In Review" });
  assert.equal(top("FSDK-21").label, "Move ticket to In Review");
  assert.equal(top("FSDK-22").action?.kind, "agent");
  assert.equal(drafts, 1);
});

test("each step is drafted once; a failure keeps no stale label and is tried again only later", async () => {
  draftFor("FSDK-30", ["Piper starts the ticket"]);
  draftFor("FSDK-31", ["An agent opens the PR"]);
  const groups = [group("FSDK-30"), group("FSDK-31", { move: true })];
  let changes = 0;
  const draft = deps(async (s) => {
    await wait(5);
    if (s.ticket === "FSDK-30") throw new Error("pi exited with code 1");
    return "Agent opens the PR";
  });
  const now = new Date("2026-10-08T10:00:00.000Z");
  assert.equal(requestStepLabels(topSteps(groups, summaries()), () => changes++, draft, now).length, 2);
  // A second page load while they run starts nothing.
  assert.deepEqual(requestStepLabels(topSteps(groups, summaries()), () => changes++, draft, now), []);
  await wait(30);
  assert.equal(changes, 2);
  // The model failed, but the action is known: the button shows with the fallback label.
  assert.equal(top("FSDK-30").label, null);
  assert.equal(top("FSDK-30").action?.kind, "agent");
  assert.deepEqual(requestStepLabels(topSteps(groups, summaries()), () => {}, draft, new Date("2026-10-08T10:01:00.000Z")), []);
  assert.deepEqual(requestStepLabels(topSteps(groups, summaries()), () => {}, draft, new Date("2026-10-08T10:06:00.000Z")), [top("FSDK-30").id]);
});

test("a label from an older version is drafted again; the old pair shows meanwhile and stays when the action cannot be read", async () => {
  draftFor("FSDK-40", ["Piper moves the ticket to In Review"]);
  const id = top("FSDK-40").id;
  const now = new Date("2026-10-08T10:00:00.000Z");
  db.claimStepLabels([id], 1, now.toISOString(), now);
  db.finishStepLabel(id, { kind: "move", to: "In Review" }, "Move ticket to In Review");
  const failing = deps(async () => "x", async () => {
    throw new Error("Jira is down");
  });
  assert.equal(requestStepLabels(topSteps([group("FSDK-40", { move: true })], summaries()), () => {}, failing, now).length, 1);
  await wait(10);
  assert.equal(top("FSDK-40").label, "Move ticket to In Review");
  assert.deepEqual(top("FSDK-40").action, { kind: "move", to: "In Review" });
});
