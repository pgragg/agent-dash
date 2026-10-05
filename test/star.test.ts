import assert from "node:assert/strict";
import { test } from "node:test";
import { starredFirst } from "../web/src/star.ts";

test("starred items come first, and each half keeps its order", () => {
  assert.deepEqual(starredFirst([1, 2, 3, 4, 5], (n) => n % 2 === 0), [2, 4, 1, 3, 5]);
  assert.deepEqual(starredFirst([3, 1], () => false), [3, 1]);
});
