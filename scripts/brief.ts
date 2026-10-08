/**
 * Lint, save and export ticket briefs: the JSON spec that agent-dash shows as a ticket's brief.
 * docs/ticket-brief/GUIDE.md says how to write one.
 *
 *   node scripts/brief.ts skeleton > brief.json
 *   node scripts/brief.ts lint --file brief.json
 *   node scripts/brief.ts save --id 7 --file brief.json         lint, then replace document 7; prints the diff
 *   node scripts/brief.ts create --ticket ABC-1 --file brief.json  a new ticket brief, when the ticket has none
 *   node scripts/brief.ts show --id 7 > brief.json
 *   node scripts/brief.ts text --id 7 | --file brief.json       reading order, for the cold-reader test
 *   node scripts/brief.ts tldr --id 7 | --file brief.json [--link URL]
 *   node scripts/brief.ts export --id 7 | --file brief.json --out DIR
 *   node scripts/brief.ts diff --file old.json --file new.json  or  diff --id 7 --file new.json
 *
 * `save` and `create` refuse a spec with lint errors. Only `save`, `create` and `--id` touch the database.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Brief, briefText, briefTldr, diffBriefs, lintBrief, parseBrief } from "../shared/brief.ts";
import { briefDocument, briefSvgs } from "../shared/briefRender.ts";

const USAGE = `usage: node scripts/brief.ts skeleton
       node scripts/brief.ts lint --file F
       node scripts/brief.ts save --id N --file F [--title TEXT]
       node scripts/brief.ts create --ticket KEY --file F
       node scripts/brief.ts show --id N
       node scripts/brief.ts text|tldr (--id N | --file F) [--link URL]
       node scripts/brief.ts export (--id N | --file F) --out DIR
       node scripts/brief.ts diff (--id N | --file OLD) --file NEW`;

const SKELETON = new URL("../docs/ticket-brief/skeleton.json", import.meta.url).pathname;

/** The database opens only for a command that needs it, so lint and export work anywhere. */
const store = () => import("../server/summaries/db.ts");

function readSpec(path: string): { raw: unknown; brief: Brief | null } {
  const text = readFileSync(resolve(path), "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not JSON: ${(err as Error).message}`);
  }
  return { raw, brief: parseBrief(text) };
}

function report(raw: unknown): boolean {
  const l = lintBrief(raw);
  for (const e of l.errors) console.error(`error   ${e}`);
  for (const w of l.warnings) console.error(`warning ${w}`);
  console.error(`${l.errors.length} errors, ${l.warnings.length} warnings, ${l.words} visible words.`);
  return l.errors.length === 0;
}

async function briefFromId(id: string | undefined): Promise<{ id: number; brief: Brief; ticket: string | null }> {
  const db = await store();
  const doc = db.getDocument(Number(id));
  if (!doc) throw new Error(`no document with --id ${id ?? ""}`);
  const brief = parseBrief(doc.body);
  if (!brief) throw new Error(`document ${doc.id} is ${doc.body ? "markdown, not a brief" : "empty: an agent still writes it"}`);
  return { id: doc.id, brief, ticket: doc.ticket };
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { id: { type: "string" }, ticket: { type: "string" }, title: { type: "string" }, file: { type: "string", multiple: true }, out: { type: "string" }, link: { type: "string" } },
  });
  const command = positionals[0];
  const files = values.file ?? [];
  const one = async (): Promise<Brief> => {
    if (values.id) return (await briefFromId(values.id)).brief;
    if (!files[0]) throw new Error("give --id or --file");
    const { raw, brief } = readSpec(files[0]);
    if (!brief) {
      report(raw);
      throw new Error(`${files[0]} is not a ticket brief`);
    }
    return brief;
  };

  if (command === "skeleton") process.stdout.write(readFileSync(SKELETON, "utf8"));
  else if (command === "lint") {
    if (!files[0]) throw new Error("--file is missing");
    if (!report(readSpec(files[0]).raw)) process.exit(1);
  } else if (command === "save" || command === "create") {
    if (!files[0]) throw new Error("--file is missing");
    const { raw, brief } = readSpec(files[0]);
    if (!report(raw) || !brief) throw new Error("not saved: fix the errors first");
    const text = `${JSON.stringify(brief, null, 2)}\n`;
    const title = values.title?.trim() || `${brief.key}: ${brief.title}`.slice(0, 200);
    const db = await store();
    if (command === "save") {
      const doc = db.getDocument(Number(values.id));
      if (!doc) throw new Error(`no document with --id ${values.id ?? ""}`);
      const old = parseBrief(doc.body);
      if (doc.ticket && doc.ticket !== brief.key) throw new Error(`document ${doc.id} is on ${doc.ticket}, but the spec's key is ${brief.key}`);
      db.saveDocument(doc.id, { body: text, title });
      console.log(`Saved brief ${doc.id}. agent-dash shows it on ${doc.ticket ?? "its page"}.`);
      if (old) console.log(`\nWhat changed:\n${diffBriefs(old, brief).join("\n")}`);
    } else {
      const key = values.ticket ?? brief.key;
      if (key !== brief.key) throw new Error(`--ticket ${key} is not the spec's key ${brief.key}`);
      const doc = db.addDocument({ ticket: key, type: "ticket-summary", title, body: text });
      if (!doc) {
        const id = db.ticketSummaryDocument(key)?.id;
        throw new Error(`${key} already has a ticket summary, document ${id}. Replace it with: node scripts/brief.ts save --id ${id} --file ${files[0]}`);
      }
      console.log(`Made brief ${doc.id} on ${key}.`);
    }
  } else if (command === "show") {
    process.stdout.write(`${JSON.stringify((await briefFromId(values.id)).brief, null, 2)}\n`);
  } else if (command === "text") process.stdout.write(briefText(await one()));
  else if (command === "tldr") process.stdout.write(briefTldr(await one(), values.link));
  else if (command === "export") {
    if (!values.out) throw new Error("--out is missing");
    const b = await one();
    const out = resolve(values.out);
    mkdirSync(join(out, "diagrams"), { recursive: true });
    writeFileSync(join(out, `${b.key}.brief.html`), briefDocument(b));
    writeFileSync(join(out, `${b.key}.tldr.md`), briefTldr(b));
    writeFileSync(join(out, `${b.key}.brief.txt`), briefText(b));
    writeFileSync(join(out, `${b.key}.brief.json`), `${JSON.stringify(b, null, 2)}\n`);
    const svgs = briefSvgs(b);
    for (const s of svgs) writeFileSync(join(out, "diagrams", s.name), s.svg);
    console.log(`Wrote ${b.key}.brief.html, .tldr.md, .brief.txt, .brief.json and ${svgs.length} diagrams to ${out}`);
  } else if (command === "diff") {
    let before: Brief;
    let after: Brief;
    if (values.id) {
      before = (await briefFromId(values.id)).brief;
      if (!files[0]) throw new Error("--file NEW is missing");
      after = readSpec(files[0]).brief ?? (() => { throw new Error(`${files[0]} is not a ticket brief`); })();
    } else {
      if (files.length !== 2) throw new Error("give --file OLD --file NEW");
      const [a, z] = files.map((f) => readSpec(f).brief);
      if (!a || !z) throw new Error("both files must be ticket briefs");
      [before, after] = [a, z];
    }
    console.log(diffBriefs(before, after).join("\n"));
  } else throw new Error(`unknown command: ${command ?? ""}`);
} catch (err) {
  console.error(`${(err as Error).message}\n${USAGE}`);
  process.exit(2);
}
