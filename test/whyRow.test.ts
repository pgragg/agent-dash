import assert from "node:assert/strict";
import { test } from "node:test";
import { rankAttention } from "../server/attention.ts";
import type { ConversationSummary } from "../shared/types.ts";
import { cutWords, rowName, rowType, withoutKey } from "../web/src/whyRow.ts";
import { NOW, minutesAgo, pr, run, ticket } from "./helpers.ts";

const summary = (about: string | null): ConversationSummary => ({ sessionId: "s1", status: "done", about, latest: "x", needs: "Nothing", generatedAt: null, error: null, stale: false });

test("a cut name ends on a whole word, with an ellipsis", () => {
  const name = "FSDK-2090: Plan a smoketest of FSDK-2090 on Postman Prod. Write the plan to the ticket";
  const cut = cutWords(name, 60);
  assert.ok(cut.endsWith("…"));
  assert.ok(name.startsWith(cut.slice(0, -1)), "the cut is a prefix of the name");
  assert.match(name.slice(cut.length - 1), /^[\s.,]/, "the cut ends at a word boundary");
  assert.equal(cutWords("short name", 60), "short name");
});

test("the page's ticket key leaves the name, with its 'of'", () => {
  assert.equal(withoutKey("FSDK-2090: Plan a smoketest of FSDK-2090 on Postman Prod.", "FSDK-2090"), "Plan a smoketest on Postman Prod.");
  assert.equal(withoutKey("FSDK-1: Fix FSDK-2 too", "FSDK-1"), "Fix FSDK-2 too");
});

test("an agent row names the summary's about, links to the agent, and does not repeat the ticket", () => {
  const [item] = rankAttention([run({ status: "awaiting_input", name: "FSDK-2090: Plan a smoketest of FSDK-2090 on Postman Prod. Write the plan", tickets: ["FSDK-2090"], statusSince: minutesAgo(13 * 60) })], [], [], NOW);
  assert.equal(rowType(item.kind), "Agent");
  assert.equal(item.status, "waiting 13h");
  const fromName = rowName(item, undefined, "FSDK-2090")!;
  assert.equal(fromName.ref, "r:s1");
  assert.doesNotMatch(fromName.text, /FSDK-2090/);
  assert.equal(rowName(item, summary("Smoketest plan for FSDK-2090 on Prod"), "FSDK-2090")!.text, "Smoketest plan on Prod");
});

test("a PR row names repo#n and the title, and links to the PR panel", () => {
  const [item] = rankAttention([], [pr({ url: "https://github.com/o/repo/pull/7", repo: "o/repo", number: 7, title: "FSDK-1: Add the thing", checks: "failure" })], [], NOW);
  assert.equal(rowType(item.kind), "PR");
  assert.equal(item.status, "CI red");
  assert.deepEqual(rowName(item, undefined, "FSDK-1"), { text: "repo#7 Add the thing", full: "repo#7 FSDK-1: Add the thing", ref: "pr:o/repo/7" });
});

test("a date row on its own ticket's page has no name; elsewhere it names the ticket", () => {
  const [item] = rankAttention([], [], [ticket({ key: "FSDK-1", dueDate: "2026-09-29" })], NOW);
  assert.equal(rowType(item.kind), "Due date");
  assert.equal(item.status, "3d late");
  assert.equal(rowName(item, undefined, "FSDK-1"), null);
  assert.equal(rowName(item, undefined, null)!.ref, "t:FSDK-1");
});
