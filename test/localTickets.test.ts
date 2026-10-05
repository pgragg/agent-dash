import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isLocalKey, localTicketDetail, readLocalTickets } from "../server/sources/localTickets.ts";

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ad-tickets-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test("the folder is the status, and the heading is the title", () => {
  const dir = folder({
    "todo/AD-2-make-it-fast.md": "# AD-2 — Make it fast\n\nbody",
    "in-review/AD-1-show-tickets.md": "# AD-1 — Show tickets\n",
    "canceled/AD-3-no-heading.md": "no heading here",
    "todo/notes.md": "# not a ticket",
  });
  const byKey = new Map(readLocalTickets(dir, 7777).map((t) => [t.key, t]));
  assert.deepEqual([...byKey.keys()].sort(), ["AD-1", "AD-2", "AD-3"]);
  assert.equal(byKey.get("AD-2")?.summary, "Make it fast");
  assert.deepEqual([byKey.get("AD-2")?.status, byKey.get("AD-2")?.statusCategory], ["To Do", "new"]);
  assert.deepEqual([byKey.get("AD-1")?.status, byKey.get("AD-1")?.statusCategory], ["In Review", "indeterminate"]);
  assert.deepEqual([byKey.get("AD-3")?.summary, byKey.get("AD-3")?.statusCategory], ["no heading", "done"]);
  assert.equal(byKey.get("AD-1")?.url, "http://127.0.0.1:7777/api/local-ticket?key=AD-1");
  assert.equal(byKey.get("AD-1")?.file, join(dir, "in-review/AD-1-show-tickets.md"));
});

test("a missing folder means no tickets", () => {
  assert.deepEqual(readLocalTickets(join(tmpdir(), "no-such-ad-folder"), 7777), []);
});

test("the detail is the file below its heading, with no Jira verbs", () => {
  const dir = folder({ "todo/AD-4-x.md": "# AD-4 — X\n\n## Why\n\nBecause." });
  const [t] = readLocalTickets(dir, 7777);
  const d = localTicketDetail(t!);
  assert.equal(d.description, "## Why\n\nBecause.");
  assert.deepEqual([d.transitions, d.comments, d.dueDate], [[], [], null]);
});

test("only AD-<n> is a local key", () => {
  assert.equal(isLocalKey("AD-12"), true);
  assert.equal(isLocalKey("FSDK-12"), false);
  assert.equal(isLocalKey("AD-12x"), false);
});
