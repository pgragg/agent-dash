import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { handle } from "../server/routes/wiki.ts";
import { isSafeRef, listWiki, readWikiNote, searchWikiDir, wikiFile } from "../server/wiki.ts";
import { parseFrontMatter, resolveRef, wikiLinkParts, wikiLinkTargets, type WikiNoteMeta } from "../shared/wiki.ts";
import { parseHash, href } from "../web/src/routes.ts";

const vault = mkdtempSync(join(tmpdir(), "agent-dash-wiki-"));
const outside = mkdtempSync(join(tmpdir(), "agent-dash-outside-"));
const put = (rel: string, text: string) => {
  mkdirSync(join(vault, rel, ".."), { recursive: true });
  writeFileSync(join(vault, rel), text);
};

put(
  "services/FDR.md",
  `---
title: FDR
type: service
tags: [postman, fern]
aliases:
  - Fern Definition Registry
updated: 2026-10-01
---

# FDR

Stores docs. Talks to [[Venus]] and [[Nowhere]].
`,
);
put("services/Venus.md", "---\ntitle: Venus\ntype: service\n---\n\nOrgs and tokens. See [[FDR|the registry]].\n");
put(
  "Fern Postman Architecture/sdk-gen database connectivity.md",
  "---\ntitle: sdk-gen database connectivity\ntype: architecture\n---\n\n## Provisioned versus connected\n\nBeta uses fern-dev2-enc5, not the Aurora.\n\n```mermaid\nflowchart LR\n  Q1[[\"not a link\"]]\n```\n",
);
put("Home.md", "# Home\n\nStart at [[Fern Definition Registry]] or [[sdk-gen database connectivity]].\n");
put("meta/templates/gotcha.md", "---\ntitle: \ntype: gotcha\n---\n");
put(".obsidian/templates.json", JSON.stringify({ folder: "meta/templates" }));
put(".trash/old.md", "# Old\n");
put("img/chart.png", "png bytes");
writeFileSync(join(outside, "secret.md"), "# Secret\n");
writeFileSync(join(outside, "secret.png"), "secret");
symlinkSync(join(outside, "secret.md"), join(vault, "linked.md"));
symlinkSync(join(outside, "secret.png"), join(vault, "linked.png"));

test("front matter: plain values, inline lists and block lists", () => {
  const fm = parseFrontMatter("---\ntitle: \"A: B\"\ntags: [x, 'y']\naliases:\n  - One\n  - Two\n---\n\n# Body\n");
  assert.equal(fm.fields.find(([k]) => k === "title")?.[1], "A: B");
  assert.deepEqual(fm.lists.tags, ["x", "y"]);
  assert.equal(fm.fields.find(([k]) => k === "tags")?.[1], "x, y");
  assert.deepEqual(fm.lists.aliases, ["One", "Two"]);
  assert.equal(fm.body, "# Body\n");
  assert.equal(fm.bodyLine, 9);
  // No front matter: the whole text is the body.
  assert.equal(parseFrontMatter("# Just a note").body, "# Just a note");
});

test("wikilinks: targets, labels, headings and embeds; code is not a link", () => {
  assert.deepEqual(wikiLinkTargets("[[A]] and [[B|label]] and [[C#Part]]\n```\n[[NotThis]]\n```\n![[img.png]]"), ["A", "B", "C", "img.png"]);
  assert.deepEqual(wikiLinkParts("[[Note#Head|Shown]]"), { embed: false, target: "Note", heading: "Head", label: "Shown" });
  assert.deepEqual(wikiLinkParts("![[x.png]]"), { embed: true, target: "x.png", heading: null, label: null });
});

test("a ref resolves by path, then file name, then title, then alias, case-insensitive", () => {
  const n = (path: string, title: string, aliases: string[] = []): WikiNoteMeta => ({ path, title, type: "", tags: [], aliases, folder: "", updated: null, status: null });
  const notes = [n("a/One.md", "First"), n("b/Two.md", "Second", ["Deux"])];
  assert.equal(resolveRef(notes, "a/One.md")?.path, "a/One.md");
  assert.equal(resolveRef(notes, "a/one")?.path, "a/One.md");
  assert.equal(resolveRef(notes, "two")?.path, "b/Two.md");
  assert.equal(resolveRef(notes, "first")?.path, "a/One.md");
  assert.equal(resolveRef(notes, "deux")?.path, "b/Two.md");
  assert.equal(resolveRef(notes, "three"), null);
});

test("the list has every note, and skips templates, dot folders and symlinks", () => {
  const paths = listWiki(vault).map((n) => n.path);
  assert.deepEqual(paths, ["Fern Postman Architecture/sdk-gen database connectivity.md", "Home.md", "services/FDR.md", "services/Venus.md"]);
  const fdr = listWiki(vault).find((n) => n.path === "services/FDR.md")!;
  assert.deepEqual([fdr.title, fdr.type, fdr.folder, fdr.updated], ["FDR", "service", "services", "2026-10-01"]);
  assert.deepEqual(fdr.tags, ["postman", "fern"]);
  assert.deepEqual(fdr.aliases, ["Fern Definition Registry"]);
  // A note with no front matter takes its first heading as the title.
  assert.equal(listWiki(vault).find((n) => n.path === "Home.md")!.title, "Home");
});

test("search needs every word, ranks the title first, and returns the matching lines", () => {
  const hits = searchWikiDir(vault, "provisioned versus connected");
  assert.equal(hits[0].path, "Fern Postman Architecture/sdk-gen database connectivity.md");
  assert.match(hits[0].lines[0].text, /Provisioned versus connected/);
  assert.equal(hits[0].lines[0].n, 6);
  assert.deepEqual(
    searchWikiDir(vault, "venus").map((h) => h.path),
    ["services/Venus.md", "services/FDR.md"],
  );
  assert.deepEqual(searchWikiDir(vault, "venus zebra"), []);
});

test("a note comes with its backlinks, found through titles and aliases", () => {
  const fdr = readWikiNote(vault, "Fern Definition Registry")!;
  assert.equal(fdr.path, "services/FDR.md");
  assert.deepEqual(fdr.backlinks.map((b) => b.path).sort(), ["Home.md", "services/Venus.md"]);
  assert.match(fdr.body, /^# FDR/);
  assert.equal(fdr.vault, vault.split("/").pop());
  // A [[link]] inside a mermaid fence is not a backlink.
  assert.deepEqual(readWikiNote(vault, "sdk-gen database connectivity")!.backlinks.map((b) => b.path), ["Home.md"]);
  assert.equal(readWikiNote(vault, "Nowhere"), null);
});

test("no ref reaches a file outside the wiki", () => {
  for (const bad of ["../x.md", "services/../../x", "/etc/passwd", "C:/x", "a\0b", ""]) assert.equal(isSafeRef(bad), false, bad);
  assert.equal(readWikiNote(vault, `../${outside.split("/").pop()}/secret`), null);
  assert.equal(readWikiNote(vault, "linked"), null);
  assert.equal(wikiFile(vault, "linked.png"), null);
  assert.equal(wikiFile(vault, "services/FDR.md"), null, "only images");
  assert.equal(wikiFile(vault, "chart.png")?.mime, "image/png");
});

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const dir = url.searchParams.get("dir") === "none" ? "" : vault;
  if (!handle(req, res, url, dir)) res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("the routes list, search, show a note, serve an image, and refuse writes", async () => {
  const list = await (await fetch(`${base}/api/wiki`)).json();
  assert.equal(list.configured, true);
  assert.equal(list.notes.length, 4);
  const hits = await (await fetch(`${base}/api/wiki?q=fern-dev2-enc5`)).json();
  assert.equal(hits[0].title, "sdk-gen database connectivity");
  const note = await fetch(`${base}/api/wiki/note?ref=${encodeURIComponent("services/Venus.md")}`);
  assert.equal(note.status, 200);
  assert.equal((await note.json()).title, "Venus");
  assert.equal((await fetch(`${base}/api/wiki/note?ref=..%2F..%2Fetc%2Fpasswd`)).status, 404);
  const img = await fetch(`${base}/api/wiki/file?ref=chart.png`);
  assert.equal(img.headers.get("content-security-policy")?.includes("sandbox"), true);
  assert.equal(await img.text(), "png bytes");
  assert.equal((await fetch(`${base}/api/wiki`, { method: "POST" })).status, 405);
  assert.deepEqual(await (await fetch(`${base}/api/wiki?dir=none`)).json(), { configured: false, dir: "", notes: [] });
});

test("the wiki has its own addresses", () => {
  assert.deepEqual(parseHash("#/wiki"), { view: "wiki", ref: null });
  const ref = "wiki:Fern Postman Architecture/sdk-gen user flows.md";
  assert.deepEqual(parseHash(href(ref)), { view: "wiki", ref: "Fern Postman Architecture/sdk-gen user flows.md" });
});
