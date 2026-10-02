import assert from "node:assert/strict";
import { test } from "node:test";
import { splitSummary } from "../shared/nextSteps.ts";

const SUMMARY = `**State:** In review.

**Next steps:**
1. Piper: create the Vault entries
   before anyone merges #13549.
2. An agent: open the parcel PR.

**Blockers:** none.`;

test("a summary splits into the text before the steps, each step, and the text after", () => {
  const parts = splitSummary(SUMMARY);
  assert.equal(parts.before, "**State:** In review.\n\n**Next steps:**");
  assert.deepEqual(parts.steps, ["Piper: create the Vault entries before anyone merges #13549.", "An agent: open the parcel PR."]);
  assert.equal(parts.after, "**Blockers:** none.");
});

test("a list that runs straight into the next label ends there", () => {
  const parts = splitSummary("**Next steps:**\n1. One\n2. Two\n**Blockers:** none");
  assert.deepEqual(parts.steps, ["One", "Two"]);
  assert.equal(parts.after, "**Blockers:** none");
});

test("a summary without a next-steps list keeps all its text before", () => {
  assert.deepEqual(splitSummary("**State:** Done."), { before: "**State:** Done.", steps: [], after: "" });
  assert.deepEqual(splitSummary("**Next steps:** none"), { before: "**Next steps:** none", steps: [], after: "" });
});
