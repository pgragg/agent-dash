import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentType } from "../shared/types.ts";
import { User } from "../shared/team.ts";
import { IMAGE, loadImage, resolvePath } from "./diagrams.ts";
import * as db from "./summaries/db.ts";

/** Agents read and write documents with this script, in this dash's database. */
export const DOCUMENT_SCRIPT = new URL("../scripts/document.ts", import.meta.url).pathname;

export const DOCUMENT_TYPES: DocumentType[] = ["document", "ticket-summary"];

/** Images are rows of their own, so a body this long is a mistake, not a document. */
export const MAX_BODY = 200_000;

export const TICKET_SUMMARY_PROMPT = `Create a ticket-summary document for this ticket. Draw out _excellent_ documentation of the desired start, middle, and end states of this ticket. Write user stories ("as a ___, I want to ___") regarding the use of the relevant services that would play a role in this migration. If there are multiple options to choose from, draw them out. You can use mermaid diagram or any other form of imagery to make your point clearer, embedding them in a markdown file that you save as a document to the sqlite database with a ticket-summary type.`;

export function validateTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const t = title.trim();
  if (!t || t.length > 200) throw new Error("a title needs 1 to 200 characters");
  return t;
}

/**
 * Stores each local image that the markdown embeds as a document image, and points the embed at
 * the stored copy. A web image and an `image:N` that is already stored stay as they are.
 */
export async function storeImages(documentId: number, markdown: string, baseDir: string): Promise<string> {
  if (!markdown.trim() || markdown.length > MAX_BODY) throw new Error(`the document needs 1 to ${MAX_BODY} characters`);
  const out: string[] = [];
  let last = 0;
  for (const m of markdown.matchAll(IMAGE)) {
    const [whole, alt, path] = m;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) continue;
    const img = await loadImage(resolvePath(path, baseDir));
    if (!img || img.kind === "mermaid") throw new Error(`cannot embed ${path}: it is not a PNG, SVG, JPEG, GIF or WebP file of 5 MB or less`);
    out.push(markdown.slice(last, m.index), `![${alt}](image:${db.addDocumentImage(documentId, { kind: img.kind, hash: img.hash, data: img.source })})`);
    last = m.index + whole.length;
  }
  return out.join("") + markdown.slice(last);
}

/** Named so that the diagram scan skips it: its diagrams show in the document. */
const draftFile = (id: number) => join(tmpdir(), `agent-dash-document-${id}.md`);

const RULES = `The document is markdown. Draw diagrams in \`\`\`mermaid fences. To embed a PNG, SVG, JPEG, GIF or WebP image, write ![alt](<path to the file>): the save stores a copy of the file in agent-dash and writes ![alt](image:<n>) in its place. Keep each ![alt](image:<n>) that is already there, unless the request is to remove it.`;

/** The first message of an agent that changes one document in place. */
export function editMessage(doc: { id: number; title: string; ticket: string | null }, prompt: string, script = DOCUMENT_SCRIPT): string {
  const file = draftFile(doc.id);
  return `Edit agent-dash document ${doc.id}, "${doc.title}"${doc.ticket ? ` on ${doc.ticket}` : ""}, as ${User()} asks:

<request>
${prompt.trim()}
</request>

Write the current document to a file, and read it:
node ${script} show --id ${doc.id} > ${file}
Change it as asked. Then save the whole new version in place of the old one, with the same id:
node ${script} save --id ${doc.id} --file ${file} [--title "<new title>"]
agent-dash shows the document as being edited until you save it. ${RULES}
Then reply with one or two sentences on what you changed, and stop.`;
}

/** The first message of an agent that writes a ticket's ticket summary, whose empty row is `id`. */
export function ticketSummaryMessage(key: string, id: number, script = DOCUMENT_SCRIPT): string {
  return `${TICKET_SUMMARY_PROMPT}

agent-dash made an empty ticket-summary document (id ${id}) for ${key}, and shows it as being written until you save it. Write the markdown in ${draftFile(id)}, then save it:
node ${script} save --id ${id} --file ${draftFile(id)} --title "<title>"
${RULES}
Then reply with one or two sentences on what the document says, and stop.`;
}
