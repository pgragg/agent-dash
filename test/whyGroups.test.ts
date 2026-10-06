import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttentionKind } from "../shared/types.ts";
import { groupWhy, statusWord } from "../web/src/whyGroups.ts";

const e = (id: string, kind: AttentionKind, minutesAgo: number, o: { info?: boolean; finished?: boolean; smoketestNeedsYou?: boolean } = {}) => ({
  id,
  item: { kind, info: o.info, since: new Date(Date.parse("2026-10-06T12:00:00Z") - minutesAgo * 60_000).toISOString() },
  finished: o.finished ?? false,
  smoketestNeedsYou: o.smoketestNeedsYou,
});

test("Piper's example: waiting agents need you, finished agents and PRs in review are updates, newest first", () => {
  const { needs, updates } = groupWhy([
    e("old wait", "awaiting_input", 13 * 60),
    e("new wait", "awaiting_input", 40),
    e("done 1", "awaiting_input", 30, { finished: true }),
    e("done 2", "awaiting_input", 600, { finished: true }),
    e("done 3", "awaiting_input", 5, { finished: true }),
    e("pr 1", "in_review", 120, { info: true }),
    e("pr 2", "in_review", 3 * 24 * 60),
  ]);
  assert.deepEqual(
    needs.map((x) => x.id),
    ["new wait", "old wait"],
  );
  assert.deepEqual(
    updates.map((x) => x.id),
    ["done 3", "done 1", "pr 1", "done 2", "pr 2"],
  );
});

test("a PR out for review never needs you, even when it is stale; a red CI does", () => {
  const { needs } = groupWhy([e("stale", "in_review", 5000), e("red", "ci_failing", 10)]);
  assert.deepEqual(
    needs.map((x) => x.id),
    ["red"],
  );
});

test("a smoketest row decides its own group", () => {
  const { needs, updates } = groupWhy([e("passed", "awaiting_input", 1, { smoketestNeedsYou: false }), e("confirm", "awaiting_input", 2, { finished: true, smoketestNeedsYou: true })]);
  assert.deepEqual([needs[0].id, updates[0].id], ["confirm", "passed"]);
  // On a Done ticket every item is info, so a smoketest is news there too.
  assert.equal(groupWhy([e("done ticket", "awaiting_input", 1, { info: true, smoketestNeedsYou: true })]).needs.length, 0);
});

test("equal times keep the score order", () => {
  const { needs } = groupWhy([e("first", "ci_failing", 10), e("second", "merge_conflict", 10)]);
  assert.deepEqual(
    needs.map((x) => x.id),
    ["first", "second"],
  );
});

test("the status chip drops its age, because the row has an age column", () => {
  assert.equal(statusWord("waiting 13h"), "waiting");
  assert.equal(statusWord("waiting 13h · guess"), "waiting · guess");
  assert.equal(statusWord("3d late"), "3d late");
  assert.equal(statusWord("asked a question"), "asked a question");
});
