import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseUsage } from "../shared/exits.ts";
import * as exits from "../server/exits.ts";
import { handle } from "../server/routes/exits.ts";
import { parseHash, usageView } from "../web/src/routes.ts";
import { PATTERN } from "./helpers.ts";

exits.open(join(mkdtempSync(join(tmpdir(), "agent-dash-usage-")), "test.db"));
const rows = () => exits.open().prepare("SELECT kind, name, ticket FROM usage ORDER BY id").all().map((r) => ({ ...r }));

// A stand-in for the page: the one click listener, the fetches it makes, and a clicked element.
class FakeElement {
  dataset: Record<string, string | undefined>;
  constructor(attrs: Record<string, string | undefined>) {
    this.dataset = { usage: attrs["data-usage"], ticket: attrs["data-ticket"] };
  }
  closest(sel: string) {
    return sel === "[data-usage]" && this.dataset.usage ? this : null;
  }
}
const sent: unknown[] = [];
let onClick: (e: { target: unknown }) => void = () => {};
Object.assign(globalThis, {
  Element: FakeElement,
  document: { addEventListener: (_: string, fn: typeof onClick) => (onClick = fn) },
  fetch: async (_: string, init: { body: string }) => void sent.push(JSON.parse(init.body)),
});
const { recordView, usage } = await import("../web/src/usage.ts");

test("a posted usage row needs a known kind and a short plain name; other ticket keys are dropped", () => {
  assert.deepEqual(parseUsage({ kind: "control", name: "snooze:until-change", ticket: "FSDK-1" }, PATTERN), { kind: "control", name: "snooze:until-change", ticket: "FSDK-1" });
  assert.deepEqual(parseUsage({ kind: "view", name: "localUrl", ticket: "ABC-1" }, PATTERN), { kind: "view", name: "localUrl", ticket: null });
  assert.equal(parseUsage({ kind: "exit", name: "star" }, PATTERN), null);
  assert.equal(parseUsage({ kind: "view", name: "<b>" }, PATTERN), null);
  assert.equal(parseUsage({ kind: "view", name: "x".repeat(41) }, PATTERN), null);
  assert.equal(parseUsage(null, PATTERN), null);
});

async function call(method: string, body: string, headers: Record<string, string> = { "x-agent-dash": "1" }) {
  const req = Object.assign(Readable.from([body]), { method, headers }) as unknown as IncomingMessage;
  const out = { code: 0 };
  const res = { writeHead: (code: number) => ((out.code = code), res), end: () => {} } as unknown as ServerResponse;
  assert.equal(await handle(req, res, new URL("http://x/api/usage")), true);
  return out.code;
}

test("POST /api/usage adds one row; a bad one adds none", async () => {
  const star = JSON.stringify({ kind: "control", name: "star", ticket: "FSDK-2" });
  assert.equal(await call("POST", star, {}), 403);
  assert.equal(await call("POST", "not json"), 400);
  assert.equal(await call("POST", JSON.stringify({ kind: "control", name: "x".repeat(3000) })), 413);
  assert.equal(await call("GET", ""), 405);
  assert.deepEqual(rows(), []);
  assert.equal(await call("POST", star), 201);
  assert.deepEqual(rows(), [{ kind: "control", name: "star", ticket: "FSDK-2" }]);
});

test("the view name tells the queue from the kanban, and a PR's panel from the PR list", () => {
  assert.equal(usageView(parseHash("#/t:FSDK-1"), "queue"), "board");
  assert.equal(usageView(parseHash("#/"), "kanban"), "kanban");
  assert.equal(usageView(parseHash("#/prs"), "kanban"), "prs");
  assert.equal(usageView(parseHash("#/pr:o/r/1"), "queue"), "pr");
  assert.equal(usageView(parseHash("#/c:abc"), "queue"), "conversation");
});

test("the page sends a view row only when the view changes, and one row per tagged click", () => {
  sent.length = 0;
  for (const v of ["board", "board", "prs", "prs", "board"]) recordView(v);
  assert.deepEqual(sent.map((u) => (u as { name: string }).name), ["board", "prs", "board"]);
  sent.length = 0;
  onClick({ target: new FakeElement(usage("snooze:1h", "FSDK-3")) });
  onClick({ target: new FakeElement(usage("board:kanban")) });
  onClick({ target: new FakeElement({}) });
  onClick({ target: "text" });
  assert.deepEqual(sent, [
    { kind: "control", name: "snooze:1h", ticket: "FSDK-3" },
    { kind: "control", name: "board:kanban", ticket: null },
  ]);
});
