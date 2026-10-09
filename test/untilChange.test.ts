import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as db from "../server/summaries/db.ts";
import { DEFAULT_SNOOZE, snoozeAction } from "../web/src/snooze.ts";
import { importLegacy, isMarked, LEGACY_KEY, type Marks, type Pending, settle, withPending } from "../web/src/untilChange.ts";

db.open(join(mkdtempSync(join(tmpdir(), "agent-dash-until-change-")), "test.db"));

const clickTime = (id: string) => (db.open().prepare("SELECT marked_at AS at FROM until_change WHERE entry_id = ?").get(id) as { at: string } | undefined)?.at;

test("a mark is saved with its click time, replaced, and cleared", () => {
  db.setUntilChange("t:AD-1", "awaiting_input@1", new Date("2026-10-09T10:00:00Z"));
  db.setUntilChange("t:AD-1", "awaiting_input@2", new Date("2026-10-09T11:00:00Z"));
  db.setUntilChange("r:abc", "ci_failed@1", new Date("2026-10-09T12:00:00Z"));
  assert.deepEqual(db.untilChangeMarks(), { "t:AD-1": "awaiting_input@2", "r:abc": "ci_failed@1" });
  assert.equal(clickTime("t:AD-1"), "2026-10-09T11:00:00.000Z");
  // Back to the queue: the mark goes, and the row keeps the time of that click.
  db.setUntilChange("r:abc", null, new Date("2026-10-09T13:00:00Z"));
  assert.equal("r:abc" in db.untilChangeMarks(), false);
  assert.equal(clickTime("r:abc"), "2026-10-09T13:00:00.000Z");
});

test("the import adds only the entries that SQLite does not have, and a second import adds nothing", () => {
  db.setUntilChange("t:AD-2", "newer", new Date("2026-10-09T10:00:00Z"));
  db.setUntilChange("t:AD-3", null, new Date("2026-10-09T10:00:00Z"));
  const old = { "t:AD-2": "older", "t:AD-3": "older", "t:AD-4": "fp4" };
  assert.equal(db.importUntilChange(old, new Date("2026-10-09T14:00:00Z")), 1);
  const marks = db.untilChangeMarks();
  assert.equal(marks["t:AD-2"], "newer");
  assert.equal("t:AD-3" in marks, false, "a cleared mark stays cleared");
  assert.equal(marks["t:AD-4"], "fp4");
  assert.equal(clickTime("t:AD-4"), "2026-10-09T14:00:00.000Z");
  assert.equal(clickTime("t:AD-2"), "2026-10-09T10:00:00.000Z");
  assert.equal(db.importUntilChange(old), 0);
  assert.deepEqual(db.untilChangeMarks(), marks);
});

function memoryStorage(init: Record<string, string>) {
  const items = { ...init };
  return { items, getItem: (k: string) => items[k] ?? null, removeItem: (k: string) => void delete items[k] };
}

test("the localStorage import sends the marks once, then removes the key", async () => {
  const storage = memoryStorage({ [LEGACY_KEY]: JSON.stringify({ "t:AD-5": "fp" }) });
  const sent: Marks[] = [];
  const send = async (m: Marks) => (sent.push(m), null);
  await importLegacy(storage, send);
  await importLegacy(storage, send);
  assert.deepEqual(sent, [{ "t:AD-5": "fp" }]);
  assert.equal(LEGACY_KEY in storage.items, false);
});

test("a failed import keeps the key for the next load; bad or empty data is removed without a send", async () => {
  const storage = memoryStorage({ [LEGACY_KEY]: JSON.stringify({ "t:AD-6": "fp" }) });
  await importLegacy(storage, async () => "server down");
  assert.equal(LEGACY_KEY in storage.items, true);
  for (const raw of ["not json", "{}", "[]", '{"t:AD-7": 3}']) {
    const bad = memoryStorage({ [LEGACY_KEY]: raw });
    let sends = 0;
    await importLegacy(bad, async () => (sends++, null));
    assert.equal(sends, 0, raw);
    assert.equal(LEGACY_KEY in bad.items, false, raw);
  }
});

// The queue keeps the entries whose mark does not match, as App.tsx does.
const queueOf = (entries: { id: string; fingerprint: string }[], marks: Marks) => entries.filter((s) => !isMarked(marks, s)).map((s) => s.id);

test("E hides the entry at once, and it stays hidden while an older load comes back", () => {
  const entries = [
    { id: "t:AD-1", fingerprint: "a" },
    { id: "t:AD-2", fingerprint: "b" },
  ];
  let pending: Pending = { "t:AD-1": "a" };
  assert.deepEqual(queueOf(entries, withPending({}, pending)), ["t:AD-2"]);
  pending = settle({}, pending);
  assert.deepEqual(queueOf(entries, withPending({}, pending)), ["t:AD-2"], "the server has not saved it yet");
  pending = settle({ "t:AD-1": "a" }, pending);
  assert.deepEqual(pending, {});
  assert.deepEqual(queueOf(entries, withPending({ "t:AD-1": "a" }, pending)), ["t:AD-2"]);
});

test("a new signal or Back to the queue brings the entry back", () => {
  const server = { "t:AD-1": "a" };
  assert.deepEqual(queueOf([{ id: "t:AD-1", fingerprint: "a+new" }], server), ["t:AD-1"]);
  const pending: Pending = { "t:AD-1": null };
  assert.deepEqual(queueOf([{ id: "t:AD-1", fingerprint: "a" }], withPending(server, pending)), ["t:AD-1"]);
  assert.deepEqual(settle({}, pending), {});
});

test("Z presses the picked option: a time by default, or until something changes", () => {
  const now = new Date(2026, 9, 9, 15, 0);
  assert.deepEqual(snoozeAction(DEFAULT_SNOOZE, now), { kind: "time", at: new Date(2026, 9, 10, 9) });
  assert.deepEqual(snoozeAction("change", now), { kind: "change" });
  assert.equal(snoozeAction("date", now, ""), null);
});
