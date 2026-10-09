import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// These layout rules have no logic to unit-test, so the tests read the style sheet and the markup.
const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");

/** The declarations of every top-level rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const found = css.split(`\n${selector} {`).slice(1).map((r) => r.slice(0, r.indexOf("}")));
  assert.ok(found.length, `no rule for ${selector}`);
  return found.join(";");
}

test("Full screen is in the workspace header row, not a floating button", () => {
  assert.doesNotMatch(css, /\.(ws|drawer)-tools\b/);
  assert.doesNotMatch(app, /className="(ws|drawer)-tools"/);
  assert.match(app, /<SnoozeControl [^\n]*\/>\s*<ViewToolsSlot \/>/);
});

test("Refresh, ?, and the source dot never shrink out of the top bar", () => {
  assert.match(rule(".topbar > .btn, .topbar > .sources"), /flex: none/);
  assert.match(rule(".headline"), /min-width: 0; overflow: hidden/);
});

test("history rows share one set of columns, with the actions in the last one", () => {
  assert.match(rule(".history"), /display: grid/);
  assert.match(rule(".h-row"), /grid-template-columns: subgrid/);
  assert.match(rule(".h-actions"), /grid-column: -2/);
  // Every history row puts its buttons in the actions column.
  const rows = app.split('<div className="h-row">').slice(1);
  assert.equal(rows.length, 4);
  for (const row of rows) assert.match(row.slice(0, row.indexOf("</div>")), /className="h-actions"/);
});

test("the help dialog fits the window and scrolls inside", () => {
  assert.match(rule(".help"), /max-height: 90vh; overflow-y: auto/);
});
