import assert from "node:assert/strict";
import { test } from "node:test";
import { clampWidth, DEFAULT_WIDTH, MIN_WIDTH } from "../web/src/viewWidth.ts";

test("clampWidth keeps the ticket view between the minimum and the room on the screen", () => {
  assert.equal(clampWidth(1000.4, 1600), 1000);
  assert.equal(clampWidth(100, 1600), MIN_WIDTH);
  assert.equal(clampWidth(3000, 1600), 1600);
  // A window narrower than the minimum still gives the minimum, not a negative or tiny width.
  assert.equal(clampWidth(900, 300), MIN_WIDTH);
  assert.equal(clampWidth(2400, Infinity), 2400);
});

test("clampWidth gives the default for a stored value that is not a number", () => {
  assert.equal(clampWidth(Number("junk"), 1600), DEFAULT_WIDTH);
});
