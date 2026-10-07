import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { findInReply, findInWrite, mermaidTitle, sha1, sniffImage } from "../server/diagrams.ts";
import { syncDiagrams } from "../server/diagramSync.ts";
import { handle } from "../server/routes/diagrams.ts";
import { parseSession } from "../server/sources/sessions.ts";
import * as db from "../server/summaries/db.ts";
import { header, jsonl, PATTERN, reply, user } from "./helpers.ts";

const tmp = mkdtempSync(join(tmpdir(), "agent-dash-diagrams-"));
db.open(join(tmp, "test.db"));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of a png")]);
const fence = (code: string) => "```mermaid\n" + code + "\n```";

test("a mermaid fence in a reply is a diagram, titled by itself, else by the line before it, else by its type", () => {
  const text = `Here is the flow:\n\n${fence("flowchart LR\n  A --> B")}\n\n${fence("pie title Time spent\n  \"a\" : 1")}\n\n${fence("---\ntitle: Release\n---\nsequenceDiagram\n  A->>B: hi")}`;
  const found = findInReply(text, "/repo", "2026-10-05T10:00:00Z");
  assert.deepEqual(
    found.map((f) => [f.kind, f.title]),
    [
      ["mermaid", "Here is the flow"],
      ["mermaid", "Time spent"],
      ["mermaid", "Release"],
    ],
  );
  assert.equal(found[0].kind === "mermaid" && found[0].hash, sha1("flowchart LR\n  A --> B"));
  assert.equal(mermaidTitle("sequenceDiagram\n  A->>B: hi", ""), "Sequence diagram");
  // Another language is no diagram, and an image line is no title.
  assert.deepEqual(findInReply("```ts\nconst a = 1\n```", "/repo", null), []);
  assert.equal(findInReply(`![x](a.png)\n${fence("graph TD\n A-->B")}`, "/repo", null).find((f) => f.kind === "mermaid")?.title, "Flowchart");
});

test("an embedded local image is a diagram to read later; a web image is not", () => {
  const found = findInReply("![p95 latency](charts/p95.png) and ![logo](https://x.io/a.png) and ![](~/c.svg)", "/repo", null);
  assert.deepEqual(
    found.map((f) => f.kind === "file" && [f.title, f.path.replace(/^\/Users\/[^/]+/, "~"), f.origin]),
    [
      ["p95 latency", "/repo/charts/p95.png", "charts/p95.png"],
      ["c.svg", "~/c.svg", "~/c.svg"],
    ],
  );
});

test("a written .mmd or .svg file is a diagram, and so is each mermaid fence in a written markdown file", () => {
  assert.equal(findInWrite({ path: "/r/flow.mmd", content: "graph TD\n A-->B" }, null)[0].title, "flow.mmd");
  assert.equal(findInWrite({ path: "/r/a.svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" }, null)[0].kind, "svg");
  const md = findInWrite({ path: "/wiki/Autopilot.md", content: `## Architecture\n\n${fence("graph TD\n A-->B")}` }, null);
  assert.deepEqual(md.map((f) => [f.kind, f.title, f.origin]), [["mermaid", "Architecture", "/wiki/Autopilot.md"]]);
  assert.deepEqual(findInWrite({ path: "/r/a.ts", content: fence("graph TD") }, null), []);
  assert.deepEqual(findInWrite({ path: "/r/a.svg", content: "not svg" }, null), []);
});

test("an image's type comes from its bytes, not its name", () => {
  assert.equal(sniffImage(PNG), "png");
  assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg width="1"></svg>')), "svg");
  assert.equal(sniffImage(Buffer.from("SECRET=1")), null);
});

test("the session parser collects the diagrams of replies and writes", () => {
  const write = { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "w", name: "write", arguments: { path: "/r/x.mmd", content: "graph TD\n A-->B" } }] } };
  const p = parseSession(jsonl(header("s1", "/repo"), user("draw FSDK-7"), write, reply(`Done:\n${fence("graph LR\n X-->Y")}`)), "/f", new Date(), PATTERN)!;
  assert.deepEqual(p.diagrams?.map((d) => d.origin), ["/r/x.mmd", "reply"]);
});

test("sync stores each diagram once with its conversation and ticket, reads embedded images, makes a document of each, and moves them to a new ticket", async () => {
  const dir = join(tmp, "work");
  mkdirSync(dir);
  writeFileSync(join(dir, "chart.png"), PNG);
  writeFileSync(join(dir, "fake.png"), "not an image");
  const text = `Chart:\n${fence("graph LR\n A-->B")}\n![p95](chart.png) ![bad](fake.png) ![gone](missing.png)`;
  const s = parseSession(jsonl(header("sync-1", dir), user("FSDK-9 chart it"), reply(text), reply(text)), "/f", new Date(), PATTERN)!;
  await syncDiagrams([s], () => "FSDK-9");
  await syncDiagrams([s], () => "FSDK-9");
  const rows = db.listDiagrams().filter((d) => d.sessionId === "sync-1");
  assert.deepEqual(rows.map((d) => [d.kind, d.title, d.ticket]).sort(), [
    ["mermaid", "Chart", "FSDK-9"],
    ["png", "p95", "FSDK-9"],
  ]);
  const pngId = rows.find((d) => d.kind === "png")!.id;
  assert.equal(Buffer.from(db.getDiagram(pngId)!.source!, "base64").equals(PNG), true);
  // Each diagram is one document, also after a second scan.
  const docs = db.listDocuments().filter((d) => d.sessionId === "sync-1");
  assert.deepEqual(docs.map((d) => [d.title, d.ticket]).sort(), [
    ["Chart", "FSDK-9"],
    ["p95", "FSDK-9"],
  ]);
  assert.equal(db.getDocument(docs.find((d) => d.title === "Chart")!.id)!.body, "```mermaid\ngraph LR\n A-->B\n```\n");

  // The conversation opened a PR for another ticket: its diagrams and their documents follow it.
  await syncDiagrams([s], () => "FSDK-10");
  assert.deepEqual([...new Set(db.listDiagrams().filter((d) => d.sessionId === "sync-1").map((d) => d.ticket))], ["FSDK-10"]);
  assert.deepEqual([...new Set(db.listDocuments().filter((d) => d.sessionId === "sync-1").map((d) => d.ticket))], ["FSDK-10"]);
});

test("a newer write of a file replaces the diagrams of its older writes, and their documents", async () => {
  const write = (id: string, content: string) => ({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "write", arguments: { path: "/r/notes.md", content } }] } });
  const lines = [header("rewrite-1", "/repo"), user("FSDK-11 draw it"), write("w1", fence("graph LR\n A -- --bad --> B")), reply(`Also:\n${fence("graph TD\n R-->S")}`)];
  await syncDiagrams([parseSession(jsonl(...lines), "/f", new Date(), PATTERN)!], () => "FSDK-11");
  lines.push(write("w2", fence("graph LR\n A --> B")));
  await syncDiagrams([parseSession(jsonl(...lines), "/f", new Date(), PATTERN)!], () => "FSDK-11");
  const rows = db.listDiagrams().filter((d) => d.sessionId === "rewrite-1");
  assert.deepEqual(rows.map((d) => [d.origin, d.hash]).sort(), [
    ["/r/notes.md", sha1("graph LR\n A --> B")],
    ["reply", sha1("graph TD\n R-->S")],
  ]);
  const docs = db.listDocuments().filter((d) => d.sessionId === "rewrite-1");
  assert.deepEqual(docs.map((d) => d.diagramId).sort(), rows.map((d) => d.id).sort());
});

test("a newer write keeps a document that was saved since, and a deleted document does not come back", async () => {
  const write = (id: string, content: string) => ({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "write", arguments: { path: "/r/plan.md", content } }] } });
  const lines = [header("rewrite-2", "/repo"), user("FSDK-12 draw it"), write("w1", fence("graph LR\n P-->Q")), reply(`Also:\n${fence("graph TD\n X-->Y")}`)];
  await syncDiagrams([parseSession(jsonl(...lines), "/f", new Date(), PATTERN)!], () => "FSDK-12");
  const docs = db.listDocuments().filter((d) => d.sessionId === "rewrite-2");
  const written = docs.find((d) => d.title !== "Also")!;
  const replied = docs.find((d) => d.title === "Also")!;
  db.saveDocument(written.id, { body: "# My notes\n\n```mermaid\ngraph LR\n P-->Q\n```" }, new Date(Date.parse(written.createdAt) + 60_000));
  assert.equal(db.deleteDocument(replied.id), true);
  lines.push(write("w2", fence("graph LR\n P-->R")));
  await syncDiagrams([parseSession(jsonl(...lines), "/f", new Date(), PATTERN)!], () => "FSDK-12");
  const left = db.listDocuments().filter((d) => d.sessionId === "rewrite-2");
  // Your saved version stays, without its replaced diagram; the deleted one stays gone; the new write is a new document.
  assert.deepEqual(db.getDocument(written.id)?.diagramId, null);
  assert.equal(db.getDocument(replied.id), null);
  assert.deepEqual(left.map((d) => d.id === written.id || db.getDiagram(d.diagramId!)?.hash === sha1("graph LR\n P-->R")), [true, true]);
});

test("the raw route serves a diagram's stored copy with a policy that runs no script", async () => {
  db.addDiagrams([{ key: "gone-session abc", sessionId: "gone-session", ticket: "FSDK-1", kind: "svg", title: "a", origin: "/r/a.svg", hash: "abc", source: "<svg><script>alert(1)</script></svg>", createdAt: "2026-01-01T00:00:00Z" }]);
  db.addDiagrams([{ key: "live-session png", sessionId: "live-session", ticket: null, kind: "png", title: "p", origin: "p.png", hash: "png", source: PNG.toString("base64"), createdAt: "2026-01-01T00:00:00Z" }]);
  const id = db.listDiagrams().find((d) => d.sessionId === "gone-session")!.id;
  const pngId = db.listDiagrams().find((d) => d.sessionId === "live-session")!.id;
  const server = createServer(async (req, res) => {
    if (!(await handle(req, res, new URL(req.url ?? "/", "http://localhost")))) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const raw = await fetch(`${base}/api/diagram/raw?id=${id}`);
  assert.equal(raw.headers.get("content-type"), "image/svg+xml");
  assert.match(raw.headers.get("content-security-policy") ?? "", /default-src 'none'.*sandbox/);
  const png = await fetch(`${base}/api/diagram/raw?id=${pngId}`);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await png.arrayBuffer()).equals(PNG), true);
  assert.equal((await fetch(`${base}/api/diagram/raw?id=99999`)).status, 404);
  // The JSON route and its edits are gone: a diagram is changed through its document.
  assert.equal((await fetch(`${base}/api/diagram?id=${id}`)).status, 404);
});
