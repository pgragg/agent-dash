import assert from "node:assert/strict";
import { test } from "node:test";
import { addressReview, checkList, draftNudge, fixCi, merge, rebase, verbFor } from "../shared/prVerbs.ts";
import type { AttentionKind } from "../shared/types.ts";

const pr = { url: "https://github.com/o/r/pull/7", repo: "o/r", number: 7, headRef: "fix-it", failedChecks: ["lint", "test"] };

test("Fix CI names the PR, the failing checks, and says how to read the log, and never to force-push", () => {
  const m = fixCi(pr);
  assert.equal(m.split("\n")[0], "Fix CI on r#7: lint, test");
  assert.match(m, /https:\/\/github\.com\/o\/r\/pull\/7/);
  assert.match(m, /`lint`, `test`/);
  assert.match(m, /--log-failed/);
  assert.match(m, /gh pr checkout https:\/\/github\.com\/o\/r\/pull\/7/);
  assert.match(m, /Never force-push/);
  assert.doesNotMatch(fixCi({ ...pr, failedChecks: [] }), /Failing checks/);
});

test("Address review reads unresolved threads, and posts nothing on GitHub", () => {
  const m = addressReview(pr);
  assert.match(m, /isResolved/);
  assert.match(m, /Post nothing on GitHub/);
  assert.match(m, /show the drafts to me/);
});

test("Rebase checks for a shallow clone first, and merges the base instead of force-pushing", () => {
  const m = rebase(pr);
  assert.match(m.split("\n").find((l) => l.startsWith("1."))!, /git rev-parse --is-shallow-repository/);
  assert.match(m, /Never force-push/);
});

test("Merge runs gh pr merge with the repo's default method, and Draft a nudge posts nothing", () => {
  const m = merge(pr);
  assert.match(m, /gh pr merge https:\/\/github\.com\/o\/r\/pull\/7/);
  assert.match(m, /viewerDefaultMergeMethod/);
  assert.match(draftNudge(pr), /Do NOT post it/);
});

test("each PR signal has one verb; Merge asks first; a healthy review has none", () => {
  const v = (kind: AttentionKind, info?: boolean) => verbFor({ kind, info }, pr);
  assert.equal(v("ci_failing")?.label, "Fix CI");
  assert.equal(v("changes_requested")?.label, "Address review");
  assert.equal(v("merge_conflict")?.label, "Rebase");
  assert.equal(v("ready_to_merge")?.label, "Merge");
  assert.ok(v("ready_to_merge")?.confirm);
  assert.equal(v("ci_failing")?.confirm, undefined);
  assert.equal(v("in_review")?.label, "Draft a nudge");
  assert.equal(v("in_review", true), null);
  assert.equal(v("awaiting_input"), null);
  assert.equal(v("ci_failing")?.message, fixCi(pr));
});

test("checkList keeps the line short", () => {
  assert.equal(checkList(["a"]), "a");
  assert.equal(checkList(["a", "b", "c", "d"], 2), "a, b, +2 more");
});
