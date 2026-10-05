import assert from "node:assert/strict";
import { test } from "node:test";
import { isSnoozed, snoozeUntil } from "../web/src/snooze.ts";

// A Friday, 15:30 local time.
const friday = new Date(2026, 9, 2, 15, 30);

test("hour options count from now; day options land at 9:00 local", () => {
  assert.equal(snoozeUntil("1h", friday)!.getTime() - friday.getTime(), 3_600_000);
  assert.deepEqual(snoozeUntil("tomorrow", friday), new Date(2026, 9, 3, 9));
  assert.deepEqual(snoozeUntil("1w", friday), new Date(2026, 9, 9, 9));
  assert.deepEqual(snoozeUntil("monday", friday), new Date(2026, 9, 5, 9));
  // On a Monday, "next Monday" is a week out, not today.
  assert.deepEqual(snoozeUntil("monday", new Date(2026, 9, 5, 8)), new Date(2026, 9, 12, 9));
});

test("a picked date needs a valid day in the future", () => {
  assert.deepEqual(snoozeUntil("date", friday, "2026-10-20"), new Date(2026, 9, 20, 9));
  assert.equal(snoozeUntil("date", friday, ""), null);
  assert.equal(snoozeUntil("date", friday, "2026-10-01"), null);
});

test("a snooze in the past no longer hides the ticket", () => {
  assert.equal(isSnoozed(undefined, friday.getTime()), false);
  assert.equal(isSnoozed(new Date(2026, 9, 3).toISOString(), friday.getTime()), true);
  assert.equal(isSnoozed(new Date(2026, 9, 1).toISOString(), friday.getTime()), false);
});
