import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { findInWrite } from "../server/diagrams.ts";
import { editMessage, storeImages, TICKET_SUMMARY_PROMPT, ticketSummaryMessage } from "../server/documents.ts";
import { handle } from "../server/routes/documents.ts";
import * as db from "../server/summaries/db.ts";

const tmp = mkdtempSync(join(tmpdir(), "agent-dash-documents-"));
const DB = join(tmp, "test.db");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of a png")]);

// A database from before documents: it has diagrams only. Opening it runs the migration.
{
  const raw = new DatabaseSync(DB);
  raw.exec(`CREATE TABLE diagrams (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, ticket TEXT, kind TEXT NOT NULL, title TEXT NOT NULL,
    origin TEXT NOT NULL, hash TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, edited_at TEXT, deleted_at TEXT)`);
  const add = raw.prepare("INSERT INTO diagrams (key, session_id, ticket, kind, title, origin, hash, source, created_at, edited_at, deleted_at) VALUES (?, ?, ?, ?, ?, 'reply', ?, ?, ?, ?, ?)");
  add.run("s1 a", "s1", "FSDK-5", "mermaid", "Flow", "a", "graph LR\n A-->B\n", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", null);
  add.run("s1 b", "s1", "FSDK-5", "png", "Latency [p95]", "b", PNG.toString("base64"), "2026-01-03T00:00:00Z", null, null);
  add.run("s1 c", "s1", "FSDK-5", "mermaid", "Gone", "c", "graph TD", "2026-01-04T00:00:00Z", null, "2026-01-05T00:00:00Z");
  raw.close();
}
db.open(DB);

test("each diagram that is not deleted became a document with that one diagram", () => {
  const docs = db.listDocuments().filter((d) => d.diagramId !== null);
  assert.deepEqual(
    docs.map((d) => [d.title, d.ticket, d.type, d.sessionId, d.updatedAt]),
    [
      ["Latency [p95]", "FSDK-5", "document", "s1", "2026-01-03T00:00:00Z"],
      ["Flow", "FSDK-5", "document", "s1", "2026-01-02T00:00:00Z"],
    ],
  );
  assert.equal(db.getDocument(docs[1].id)!.body, "```mermaid\ngraph LR\n A-->B\n```\n");
  const image = db.getDocument(docs[0].id)!.body.match(/^!\[Latency p95\]\(image:(\d+)\)\n$/);
  assert.ok(image);
  assert.deepEqual(db.getDocumentImage(Number(image[1])), { kind: "png", data: PNG.toString("base64") });
});

test("a save stores each local image and points the embed at the copy; a web image stays", async () => {
  const doc = db.addDocument({ ticket: "FSDK-6", type: "document", title: "Plan", body: "" })!;
  writeFileSync(join(tmp, "chart.png"), PNG);
  const body = await storeImages(doc.id, "# Plan\n\n![chart](chart.png) ![again](./chart.png) ![logo](https://x.io/a.png) ![kept](image:3)", tmp);
  const [, a, b] = body.match(/!\[chart\]\(image:(\d+)\) !\[again\]\(image:(\d+)\)/)!;
  assert.equal(a, b);
  assert.match(body, /!\[logo\]\(https:\/\/x\.io\/a\.png\) !\[kept\]\(image:3\)$/);
  await assert.rejects(storeImages(doc.id, "![x](missing.png)", tmp), /cannot embed missing\.png/);
  await assert.rejects(storeImages(doc.id, "  ", tmp), /1 to/);
});

test("a ticket has at most one ticket summary, and a save ends the edit with the same id", () => {
  const first = db.addDocument({ ticket: "FSDK-7", type: "ticket-summary", title: "Ticket summary", body: "", edit: { prompt: "p", sessionId: "s-7" } })!;
  assert.deepEqual([first.hasBody, first.edit?.sessionId, first.sessionId], [false, "s-7", "s-7"]);
  assert.equal(db.addDocument({ ticket: "FSDK-7", type: "ticket-summary", title: "Again", body: "x" }), null);
  // Another ticket, and a plain document on this one, are fine.
  assert.ok(db.addDocument({ ticket: "FSDK-8", type: "ticket-summary", title: "T", body: "x" }));
  assert.ok(db.addDocument({ ticket: "FSDK-7", type: "document", title: "D", body: "x" }));
  assert.equal(db.startDocumentEdit(first.id, "again", "s-8"), false);
  assert.equal(db.saveDocument(first.id, { body: "# Done", title: "FSDK-7 summary" }), true);
  const saved = db.getDocument(first.id)!;
  assert.deepEqual([saved.body, saved.title, saved.edit, saved.hasBody], ["# Done", "FSDK-7 summary", null, true]);
  // The ticket summary comes first on its ticket.
  assert.equal(db.listDocuments().find((d) => d.ticket === "FSDK-7")?.id, first.id);
});

test("a cancelled edit keeps the document; a cancelled first version removes it", () => {
  const doc = db.addDocument({ ticket: "FSDK-9", type: "document", title: "D", body: "old" })!;
  assert.equal(db.startDocumentEdit(doc.id, "shorter", "s-9"), true);
  assert.equal(db.clearDocumentEdit(doc.id), true);
  assert.deepEqual([db.getDocument(doc.id)?.body, db.getDocument(doc.id)?.edit], ["old", null]);
  assert.equal(db.clearDocumentEdit(doc.id), false);
  const empty = db.addDocument({ ticket: "FSDK-9", type: "ticket-summary", title: "T", body: "", edit: { prompt: "p", sessionId: "s-10" } })!;
  db.clearDocumentEdit(empty.id);
  assert.equal(db.getDocument(empty.id), null);
});

test("the agent's draft file adds no diagrams; its messages name the script, the id and the draft", () => {
  const fence = "```mermaid\ngraph TD\n A-->B\n```";
  assert.deepEqual(findInWrite({ path: "/tmp/agent-dash-document-4.md", content: fence }, null), []);
  assert.equal(findInWrite({ path: "/tmp/notes.md", content: fence }, null).length, 1);
  const edit = editMessage({ id: 4, title: "Plan", ticket: "FSDK-1" }, "add a diagram", "/s.ts");
  assert.match(edit, /node \/s\.ts show --id 4 > .*agent-dash-document-4\.md/);
  assert.match(edit, /node \/s\.ts save --id 4 --file .*agent-dash-document-4\.md/);
  assert.match(edit, /<request>\nadd a diagram\n<\/request>/);
  const summary = ticketSummaryMessage("FSDK-1", 5, "/b.ts", "http://127.0.0.1:7777/#/doc:5");
  assert.ok(summary.startsWith(TICKET_SUMMARY_PROMPT));
  assert.match(summary, /docs\/ticket-brief\/GUIDE\.md/);
  assert.match(summary, /node \/b\.ts skeleton > .*agent-dash-brief-5\.json/);
  assert.match(summary, /node \/b\.ts save --id 5 --file .*agent-dash-brief-5\.json/);
  assert.match(summary, /open http:\/\/127\.0\.0\.1:7777\/#\/doc:5/);
  // A brief's edit uses the brief tools and its update mode; a markdown edit does not.
  const briefEdit = editMessage({ id: 6, title: "B", ticket: "FSDK-1", brief: true }, "the PR merged", "/s.ts", "/b.ts");
  assert.match(briefEdit, /node \/b\.ts show --id 6 > .*agent-dash-brief-6\.json/);
  assert.match(briefEdit, /verified_on to today/);
  assert.doesNotMatch(edit, /brief/);
});

test("the script lists, shows, saves and creates documents", () => {
  const script = new URL("../scripts/document.ts", import.meta.url).pathname;
  const env = { ...process.env, AGENT_DASH_DB: DB };
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  writeFileSync(join(tmp, "doc.md"), "# Rollout\n\n![chart](chart.png)\n");
  const made = run("create", "--ticket", "FSDK-12", "--title", "Rollout", "--file", join(tmp, "doc.md"), "--type", "ticket-summary");
  assert.equal(made.status, 0, made.stderr);
  const id = Number(made.stdout.match(/document (\d+)/)![1]);
  assert.match(run("show", "--id", String(id)).stdout, /^# Rollout\n\n!\[chart\]\(image:\d+\)\n$/);
  assert.match(run("list", "--ticket", "FSDK-12").stdout, new RegExp(`^${id}\tticket-summary\t.*\tRollout\n$`));
  const again = run("create", "--ticket", "FSDK-12", "--title", "R2", "--file", join(tmp, "doc.md"), "--type", "ticket-summary");
  assert.equal(again.status, 2);
  assert.match(again.stderr, new RegExp(`already has a ticket-summary, document ${id}`));
  writeFileSync(join(tmp, "doc.md"), "# Rollout v2\n");
  assert.equal(run("save", "--id", String(id), "--file", join(tmp, "doc.md"), "--title", "Rollout 2").status, 0);
  assert.equal(execFileSync(process.execPath, [script, "show", "--id", String(id)], { env, encoding: "utf8" }), "# Rollout v2\n");
  assert.equal(run("save", "--id", "99999", "--file", join(tmp, "doc.md")).status, 2);
  // A failed image leaves no half-made document.
  writeFileSync(join(tmp, "bad.md"), "![x](nope.png)");
  assert.equal(run("create", "--ticket", "FSDK-13", "--title", "Bad", "--file", join(tmp, "bad.md")).status, 2);
  assert.equal(run("list", "--ticket", "FSDK-13").stdout, "");
});

test("the routes start an editing agent, write a ticket summary once, and serve images", async () => {
  const started: { message?: string; name?: string; sessionId?: string; onSpawnError?: () => void }[] = [];
  let changes = 0;
  const server = createServer(async (req, res) => {
    const deps = { context: async (k: string) => (k === "FSDK-20" ? "[context]" : null), onChange: () => changes++, script: "/s.ts", briefScript: "/b.ts", start: (o: (typeof started)[number]) => (started.push(o), o.sessionId ?? "") };
    if (!(await handle(req, res, new URL(req.url ?? "/", "http://localhost"), deps as never))) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (path: string, body: unknown, method = "POST", headers: Record<string, string> = { "X-Agent-Dash": "1" }) => fetch(`${base}${path}`, { method, headers, body: JSON.stringify(body) });

  const doc = db.addDocument({ ticket: "FSDK-20", type: "document", title: "Plan", body: "old" })!;
  assert.equal((await send(`/api/document/edit?id=${doc.id}`, { prompt: "x" }, "POST", {})).status, 403);
  assert.equal((await send(`/api/document/edit?id=${doc.id}`, { prompt: " " })).status, 400);
  assert.equal((await send(`/api/document/edit?id=${doc.id}`, { prompt: "x", cwd: "/no/such/dir" })).status, 400);
  assert.equal((await send("/api/document/edit?id=99999", { prompt: "x" })).status, 404);
  const ok = await send(`/api/document/edit?id=${doc.id}`, { prompt: "add a diagram", cwd: tmp });
  assert.equal(ok.status, 201);
  const { sessionId } = await ok.json();
  assert.equal(started[0].sessionId, sessionId);
  assert.match(started[0].name!, /^FSDK-20: Edit document \d+: add a diagram/);
  assert.ok(started[0].message!.startsWith("[context]\n\nEdit agent-dash document"));
  assert.equal(db.getDocument(doc.id)?.edit?.sessionId, sessionId);
  assert.equal((await send(`/api/document/edit?id=${doc.id}`, { prompt: "more" })).status, 409);
  assert.equal((await send(`/api/document/edit?id=${doc.id}`, undefined, "DELETE")).status, 200);
  assert.equal(db.getDocument(doc.id)?.edit, null);

  assert.equal((await send("/api/document/ticket-summary?ticket=FSDK-21", {})).status, 404);
  const made = await send("/api/document/ticket-summary?ticket=FSDK-20", { cwd: tmp });
  assert.equal(made.status, 201);
  const { documentId } = await made.json();
  const summary = db.getDocument(documentId)!;
  assert.deepEqual([summary.type, summary.hasBody, summary.edit?.prompt], ["ticket-summary", false, TICKET_SUMMARY_PROMPT]);
  assert.match(started[1].message!, new RegExp(`/b\\.ts save --id ${documentId} `));
  assert.equal(summary.title, "Ticket brief");
  assert.equal((await send("/api/document/ticket-summary?ticket=FSDK-20", { cwd: tmp })).status, 409);
  // An agent that cannot start leaves no empty ticket summary, so the button comes back.
  started[1].onSpawnError!();
  assert.equal(db.getDocument(documentId), null);
  assert.ok(changes >= 3);

  const withImage = db.addDocument({ ticket: "FSDK-20", type: "document", title: "I", body: "" })!;
  const imageId = db.addDocumentImage(withImage.id, { kind: "png", hash: "h", data: PNG.toString("base64") });
  const img = await fetch(`${base}/api/document/image?id=${imageId}`);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await img.arrayBuffer()).equals(PNG), true);
  assert.equal((await (await fetch(`${base}/api/document?id=${doc.id}`)).json()).body, "old");
});
