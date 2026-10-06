import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalFilesProvider } from "../server/tickets/localFiles.ts";
import { createProviders } from "../server/tickets/registry.ts";

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ad-tickets-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const provider = (dir: string, prefix = "AD") => new LocalFilesProvider({ id: `local-${prefix}`, prefix, dir }, 7777);

test("the folder is the status, and the heading is the title", () => {
  const dir = folder({
    "todo/AD-2-make-it-fast.md": "# AD-2 — Make it fast\n\nbody",
    "in-review/AD-1-show-tickets.md": "# AD-1 — Show tickets\n",
    "canceled/AD-3-no-heading.md": "no heading here",
    "todo/notes.md": "# not a ticket",
  });
  const byKey = new Map(provider(dir).readAll().map((t) => [t.key, t]));
  assert.deepEqual([...byKey.keys()].sort(), ["AD-1", "AD-2", "AD-3"]);
  assert.equal(byKey.get("AD-2")?.summary, "Make it fast");
  assert.deepEqual([byKey.get("AD-2")?.status, byKey.get("AD-2")?.statusCategory], ["To Do", "new"]);
  assert.deepEqual([byKey.get("AD-1")?.status, byKey.get("AD-1")?.statusCategory], ["In Review", "indeterminate"]);
  assert.deepEqual([byKey.get("AD-3")?.summary, byKey.get("AD-3")?.statusCategory], ["no heading", "done"]);
  assert.equal(byKey.get("AD-1")?.url, "http://127.0.0.1:7777/api/local-ticket?key=AD-1");
  assert.equal(byKey.get("AD-1")?.file, join(dir, "in-review/AD-1-show-tickets.md"));
  assert.deepEqual(byKey.get("AD-1")?.source, { id: "local-AD", label: "AD tickets", dueDate: false, move: true });
});

test("my tickets are the open ones; a lookup finds done ones too", async () => {
  const dir = folder({ "todo/AD-1-a.md": "# AD-1 — A", "done/AD-2-b.md": "# AD-2 — B" });
  assert.deepEqual((await provider(dir).listMine()).map((t) => t.key), ["AD-1"]);
  assert.deepEqual((await provider(dir).lookup(["AD-2", "AD-9"])).map((t) => t.key), ["AD-2"]);
});

test("a missing folder, or none set, means no tickets", async () => {
  assert.deepEqual(provider(join(tmpdir(), "no-such-ad-folder")).readAll(), []);
  assert.equal(provider("").enabled, false);
  assert.deepEqual(await provider("").listMine(), []);
});

test("any prefix works, and a provider reads only its own prefix", () => {
  const dir = folder({ "todo/NOTE-1-x.md": "# NOTE-1 — X", "todo/AD-1-y.md": "# AD-1 — Y" });
  assert.deepEqual(provider(dir, "NOTE").readAll().map((t) => [t.key, t.summary]), [["NOTE-1", "X"]]);
});

test("the detail is the file below its heading, and the other status folders are its transitions", async () => {
  const dir = folder({ "todo/AD-4-x.md": "# AD-4 — X\n\n## Why\n\nBecause." });
  const d = await provider(dir).detail("AD-4");
  assert.equal(d?.description, "## Why\n\nBecause.");
  assert.deepEqual([d?.comments, d?.dueDate], [[], null]);
  assert.deepEqual(d?.transitions.map((t) => t.to), ["In Progress", "In Review", "Done", "Canceled"]);
  assert.equal(await provider(dir).detail("AD-5"), null);
});

test("a move renames the file into the other status folder, from the status that the page showed only", async () => {
  const dir = folder({ "todo/AD-4-x.md": "# AD-4 — X" });
  const p = provider(dir);
  const changes: unknown[] = [];
  assert.equal((await p.move("AD-4", "In Progress", "In Review", (k, c) => changes.push([k, c]))).status, 409);
  assert.equal((await p.move("AD-4", "Nowhere", "To Do", () => {})).status, 409);
  const ok = await p.move("AD-4", "In Progress", "To Do", (k, c) => changes.push([k, c]));
  assert.equal(ok.status, 200);
  assert.ok(existsSync(join(dir, "in-progress/AD-4-x.md")));
  assert.ok(!existsSync(join(dir, "todo/AD-4-x.md")));
  assert.deepEqual(changes, [["AD-4", { status: "In Progress", statusCategory: "indeterminate" }]]);
  assert.equal((await p.move("AD-9", "Done", "To Do", () => {})).status, 404);
});

test("the raw text is only for a file that the scan found", () => {
  const dir = folder({ "todo/AD-4-x.md": "# AD-4 — X" });
  assert.equal(provider(dir).rawText("AD-4"), `${join(dir, "todo/AD-4-x.md")}\n\n# AD-4 — X`);
  assert.equal(provider(dir).rawText("AD-5"), null);
});

test("the registry gives a key to the provider that names its prefix, else to the one that takes any key", () => {
  const providers = createProviders(
    [
      { type: "jira", id: "jira", server: "https://j", login: "me", tokenFile: "", excludeProjects: [], projects: [] },
      { type: "local", id: "local-AD", prefix: "AD", dir: "/a" },
    ],
    { port: 7777, ttlMs: 0 },
  );
  assert.equal(providers.providerFor("AD-1")?.source.id, "local-AD");
  assert.equal(providers.providerFor("FSDK-1")?.source.id, "jira");
  assert.equal(providers.ticketUrl("FSDK-1"), "https://j/browse/FSDK-1");
  assert.equal(providers.stub("FSDK-2").summary, "(not found in Jira)");
  assert.equal(createProviders([], { port: 7777, ttlMs: 0 }).ticketUrl("FSDK-1"), null);
});
