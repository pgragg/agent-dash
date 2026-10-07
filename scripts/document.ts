/**
 * Read and write the markdown documents on a ticket, which agent-dash shows on the ticket's page:
 *
 *   node scripts/document.ts list --ticket ABC-123
 *   node scripts/document.ts show --id 7 > doc.md
 *   node scripts/document.ts save --id 7 --file doc.md [--title "New title"]
 *   node scripts/document.ts create --ticket ABC-123 --title "Rollout plan" --file doc.md [--type document|ticket-summary]
 *
 * `save` replaces the whole document, and keeps its id. Each `![alt](path)` to a local image goes
 * into the database, and becomes `![alt](image:N)`. A ticket has at most one ticket-summary.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { config } from "../server/config.ts";
import { DOCUMENT_TYPES, storeImages, validateTitle } from "../server/documents.ts";
import * as db from "../server/summaries/db.ts";
import type { DocumentType } from "../shared/types.ts";

const USAGE = `usage: node scripts/document.ts list --ticket KEY
       node scripts/document.ts show --id N
       node scripts/document.ts save --id N --file F [--title TEXT]
       node scripts/document.ts create --ticket KEY --title TEXT --file F [--type ${DOCUMENT_TYPES.join("|")}]`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { id: { type: "string" }, ticket: { type: "string" }, title: { type: "string" }, file: { type: "string" }, type: { type: "string" } },
  });
  const command = positionals[0];
  const ticket = () => {
    if (!values.ticket || !new RegExp(`^${config.ticketPattern.source}$`).test(values.ticket)) throw new Error(`not a ticket key: ${values.ticket ?? ""}`);
    return values.ticket;
  };
  const file = () => {
    if (!values.file) throw new Error("--file is missing");
    return resolve(values.file);
  };
  if (command === "list") {
    const key = ticket();
    for (const d of db.listDocuments().filter((x) => x.ticket === key)) console.log(`${d.id}\t${d.type}\t${d.updatedAt}\t${d.title}`);
  } else if (command === "show" || command === "save") {
    const doc = db.getDocument(Number(values.id));
    if (!doc) throw new Error(`no document with --id ${values.id ?? ""}`);
    if (command === "show") process.stdout.write(doc.body);
    else {
      const path = file();
      db.saveDocument(doc.id, { body: await storeImages(doc.id, readFileSync(path, "utf8"), dirname(path)), title: validateTitle(values.title) });
      console.log(`Saved document ${doc.id}. agent-dash shows the new version on ${doc.ticket ?? "its page"}.`);
    }
  } else if (command === "create") {
    const type = (values.type ?? "document") as DocumentType;
    if (!DOCUMENT_TYPES.includes(type)) throw new Error(`--type must be one of ${DOCUMENT_TYPES.join(", ")}`);
    const title = validateTitle(values.title);
    if (!title) throw new Error("--title is missing");
    const key = ticket();
    const path = file();
    const markdown = readFileSync(path, "utf8");
    // The row comes first, because each image belongs to a document.
    const doc = db.addDocument({ ticket: key, type, title, body: "" });
    if (!doc) {
      const id = db.ticketSummaryDocument(key)?.id;
      throw new Error(`${key} already has a ticket-summary, document ${id}. Change it with: node scripts/document.ts save --id ${id} --file F`);
    }
    try {
      db.saveDocument(doc.id, { body: await storeImages(doc.id, markdown, dirname(path)) });
    } catch (err) {
      db.deleteDocument(doc.id);
      throw err;
    }
    console.log(`Made document ${doc.id} on ${key}.`);
  } else {
    throw new Error(`unknown command: ${command ?? ""}`);
  }
} catch (err) {
  console.error(`${(err as Error).message}\n${USAGE}`);
  process.exit(2);
}
