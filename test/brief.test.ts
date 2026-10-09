import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Brief, briefText, briefTldr, diffBriefs, lintBrief, nodeBox, parseBrief, placeLabel, routeEdge, viewStates } from "../shared/brief.ts";
import { briefDocument, briefHtml, briefSvgs } from "../shared/briefRender.ts";
import * as db from "../server/summaries/db.ts";

const EXAMPLE = new URL("../docs/ticket-brief/examples/FSDK-2073.brief.json", import.meta.url).pathname;
const SKELETON = new URL("../docs/ticket-brief/skeleton.json", import.meta.url).pathname;
const example = (): Brief => JSON.parse(readFileSync(EXAMPLE, "utf8"));
const ON = new Date("2026-10-08T12:00:00Z");

test("the FSDK-2073 example lints clean, inside the L word budget", () => {
  const l = lintBrief(example(), ON);
  assert.deepEqual([l.errors, l.warnings], [[], []]);
  assert.ok(l.words > 800 && l.words < 1600, `${l.words} words`);
});

test("the skeleton parses as a brief; the lint flags its placeholder date", () => {
  const raw = readFileSync(SKELETON, "utf8");
  assert.ok(parseBrief(raw));
  assert.ok(lintBrief(JSON.parse(raw), ON).errors.some((e) => /verified_on must be YYYY-MM-DD/.test(e)));
});

test("a markdown body, or JSON of another shape, is not a brief", () => {
  assert.equal(parseBrief("# Plan\n\nText"), null);
  assert.equal(parseBrief('{"title": "x"}'), null);
  assert.equal(parseBrief("{ not json"), null);
});

test("the lint refuses what a reader would trip over", () => {
  const b = example();
  b.decisions!.major.push({ ...b.decisions!.major[0] }, { ...b.decisions!.major[0] });
  b.decisions!.major[0].options.forEach((o) => (o.recommended = true));
  b.decisions!.major[1].decider = "TBD";
  b.done!.items[0].verify = "";
  b.glance!.headsups!.push(...b.glance!.headsups!);
  b.system!.views[0].pins!.push({ node: "cli", text: "a fourth" });
  b.system!.views[1].edges.push({ from: "ldb", to: "fdr" });
  b.facts.push({ ...b.facts[0] });
  b.risks!.items.push({ text: "x", fact: "nope" });
  b.facts[1].text += " ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const { errors } = lintBrief(b, ON);
  const has = (re: RegExp) => assert.ok(errors.some((e) => re.test(e)), `no error matches ${re}:\n${errors.join("\n")}`);
  has(/decisions\.major: 4; at most 3/);
  has(/exactly one option must be recommended \(now 3\)/);
  has(/the decider must be a name/);
  has(/done\.items\[0\].*has no verify/);
  has(/glance\.headsups: 8/);
  has(/view today: 4 pins; at most 3/);
  has(/edge ldb→fdr: node ldb is hidden in this view/);
  has(/fact f1 is in the ledger twice/);
  has(/cites fact "nope"/);
  has(/looks like a GitHub token/);
});

test("the lint warns on topic headings, stale facts, user stories, narration and a busy small brief", () => {
  const b = example();
  b.system!.heading = "Current architecture";
  b.people!.rows[0].who = "As a platform engineer";
  b.facts[0].text = "I tested the URL and it failed.";
  b.size = "S";
  const { warnings } = lintBrief(b, new Date("2026-10-30T00:00:00Z"));
  const has = (re: RegExp) => assert.ok(warnings.some((w) => re.test(w)), `no warning matches ${re}:\n${warnings.join("\n")}`);
  has(/names a topic; write a claim/);
  has(/verified_on is 23 days old/);
  has(/a user story is a task/);
  has(/state the result, not the investigation/);
  has(/size S: drop decisions/);
  has(/visible words; the budget for size S is 900/);
});

test("a map's views say what is new, changed and removed, and edges route around boxes", () => {
  const states = viewStates(example().system!);
  assert.equal(states[0].has("fdr"), false);
  assert.equal(states[1].get("fdr"), "new");
  assert.equal(states[1].get("lambda"), "changed");
  assert.equal(states[1].get("openai"), "gone");
  assert.equal(states[2].get("fdr"), "same");
  assert.equal(states[2].has("openai"), false, "a node that the view before hid is not drawn again");
  // A straight line from col 0 to col 2 would cross the box in col 1: the route bends around it.
  const [a, mid, z] = [0, 1, 2].map((col) => nodeBox({ col, row: 0 }));
  const r = routeEdge(a, z, [mid]);
  assert.ok(r.clear && r.control, "a curve");
  assert.equal(routeEdge(a, mid, []).control, null);
  // A label wider than the gap between two boxes is not clear; a short one is.
  assert.equal(placeLabel("POST /v2/registry/ai/enhance-example", r.label, [a, mid]).clear, true);
  const gap = { x: (a.x + a.w + mid.x) / 2, y: a.y + a.h / 2 };
  assert.equal(placeLabel("a label far too wide for the gap", gap, [a, mid]).clear, false);
  assert.equal(placeLabel("ok", gap, [a, mid]).clear, true);
});

test("the page escapes every text and links only http(s) URLs", () => {
  const b = example();
  b.title = `<img src=x onerror="alert(1)">`;
  b.links = [{ label: "evil", url: "javascript:alert(1)" }];
  b.system!.nodes[0].label = "<script>x</script>";
  b.glance!.shifts[0].after = "`<b>`";
  const html = briefHtml(b);
  assert.doesNotMatch(html, /<img|<script|javascript:/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
  const doc = briefDocument(b);
  assert.match(doc, /Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(doc, /<script/);
});

test("the page has one tab per map view, the pins, and the ledger collapsed", () => {
  const html = briefHtml(example());
  assert.equal(html.match(/class="tb-radio"/g)?.length, 3);
  assert.equal(html.match(/<svg /g)?.length, 3);
  assert.match(html, /<details class="tb-sec tb-evidence">/);
  assert.match(html, /4 smaller calls/);
  assert.match(html, /1 more risk</);
  const svgs = briefSvgs(example());
  assert.deepEqual(svgs.map((s) => s.name), ["FSDK-2073.map-1-today.svg", "FSDK-2073.map-2-during.svg", "FSDK-2073.map-3-done.svg"]);
  assert.ok(svgs.every((s) => s.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && s.svg.includes("<style>")));
});

test("at a glance, the page stops after the title, the ask and the At a glance section", () => {
  const b = example();
  const html = briefHtml(b, { glanceOnly: true });
  assert.match(html, /class="tb-title"/);
  assert.match(html, /class="tb-ask"/);
  assert.match(html, /<h2>At a glance<\/h2>/);
  assert.doesNotMatch(html, /<svg |tb-evidence|tb-system/);
  assert.ok(briefHtml(b).startsWith(html.slice(0, -"</div>".length)));
});

test("the text, the TL;DR and the diff", () => {
  const b = example();
  const text = briefText(b);
  assert.match(text, /^FSDK-2073: Move fdr-lambda-docs/);
  assert.match(text, /\[Map view 2: During \(the bridge\)\]/);
  assert.match(text, /box FDR on EKS \(has the route since FSDK-2072\) \[NEW\]/);
  assert.match(text, /Prove it: /);
  const tldr = briefTldr(b, "https://x/brief");
  assert.match(tldr, /\*\*Heads-up: the ticket and reality differ\*\*/);
  assert.match(tldr, /Recommended: Lambda proxies to FDR\. Decider: Piper/);
  assert.match(tldr, /Full brief: https:\/\/x\/brief\n$/);
  assert.ok(tldr.split(/\s+/).length < 450);

  const after = example();
  after.verified_on = "2026-10-14";
  after.work!.repos[0].pr!.state = "merged";
  after.path!.steps[1].date = "2026-10-20";
  after.risks!.items.pop();
  after.facts.reverse();
  const lines = diffBriefs(b, after);
  assert.ok(lines.includes("~ verified_on: 2026-10-07 → 2026-10-14"), lines.join("\n"));
  assert.ok(lines.includes("~ work.repos[postman-eng/sdk-gen-fern-platform].pr.state: open → merged"));
  assert.ok(lines.includes("~ path.steps[M2: registry cutover].date: 2026-10-17 → 2026-10-20"));
  assert.ok(lines.some((l) => l.startsWith("- risks.items[3].text")));
  assert.ok(!lines.some((l) => l.includes("facts[")), "a reorder of facts is no change");
  assert.deepEqual(diffBriefs(b, example()), ["No change."]);
});

test("the script lints, saves with a diff, refuses errors, and exports", () => {
  const tmp = mkdtempSync(join(tmpdir(), "agent-dash-brief-"));
  const DB = join(tmp, "test.db");
  const script = new URL("../scripts/brief.ts", import.meta.url).pathname;
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, AGENT_DASH_DB: DB }, encoding: "utf8" });
  const file = join(tmp, "b.json");
  writeFileSync(file, readFileSync(EXAMPLE));
  assert.equal(run("lint", "--file", file).status, 0);

  db.open(DB);
  const empty = db.addDocument({ ticket: "FSDK-2073", type: "ticket-summary", title: "Ticket brief", body: "", edit: { prompt: "p", sessionId: "s" } })!;
  const saved = run("save", "--id", String(empty.id), "--file", file);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /Saved brief/);
  assert.equal(db.getDocument(empty.id)!.title, "FSDK-2073: Move fdr-lambda-docs into FDR on Kubernetes");
  assert.ok(parseBrief(db.getDocument(empty.id)!.body));

  const b = example();
  b.work!.repos[0].pr!.state = "merged";
  writeFileSync(file, JSON.stringify(b));
  const again = run("save", "--id", String(empty.id), "--file", file);
  assert.match(again.stdout, /What changed:\n~ work\.repos\[postman-eng\/sdk-gen-fern-platform\]\.pr\.state: open → merged/);

  b.done!.items[0].verify = "";
  writeFileSync(file, JSON.stringify(b));
  const refused = run("save", "--id", String(empty.id), "--file", file);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /has no verify[\s\S]*not saved: fix the errors first/);
  assert.match(db.getDocument(empty.id)!.body, /"merged"/, "the refused save left the last version");

  const created = run("create", "--file", EXAMPLE);
  assert.equal(created.status, 2);
  assert.match(created.stderr, new RegExp(`already has a ticket summary, document ${empty.id}`));

  const out = join(tmp, "out");
  assert.equal(run("export", "--id", String(empty.id), "--out", out).status, 0);
  assert.deepEqual(readdirSync(out).sort(), ["FSDK-2073.brief.html", "FSDK-2073.brief.json", "FSDK-2073.brief.txt", "FSDK-2073.tldr.md", "diagrams"]);
  assert.equal(readdirSync(join(out, "diagrams")).length, 3);
  assert.match(run("text", "--id", String(empty.id)).stdout, /^FSDK-2073/);
  assert.match(run("tldr", "--file", EXAMPLE).stdout, /^\*\*FSDK-2073/);
});
