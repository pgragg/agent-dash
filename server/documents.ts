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

/** Agents lint, save and export ticket briefs with this script. */
export const BRIEF_SCRIPT = new URL("../scripts/brief.ts", import.meta.url).pathname;
/** How to write a brief: the workflow, the research lanes, the visual rules and the review. */
export const BRIEF_GUIDE = new URL("../docs/ticket-brief/GUIDE.md", import.meta.url).pathname;

export const TICKET_SUMMARY_PROMPT = `Write a ticket brief for this ticket: one visual-first page that gets an engineer who has never seen this repo up to speed in about five minutes, so that they can do the ticket and nothing more. Stay on what the ticket asks: the smallest change that meets it, how to prove it is done, where the ticket disagrees with reality, and where to start. Make the work smaller: where a part of the ticket can be cut, deferred or done the simple way, say so. Do not add work: no tuning, optimization, model or tool choices, or "consider X" ideas that the ticket does not need; a choice that is already made, or that a default answers, is not a decision. Write every line in ASD-STE100 (Simplified Technical English): short sentences, one idea in each, active voice, simple common words, one term for one thing. Be an editor, not an archivist: rank, cut, and put the evidence in the ledger.`;

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
const briefDraft = (id: number) => join(tmpdir(), `agent-dash-brief-${id}.json`);

/** The steps that every brief agent follows after it writes the spec: lint, look, test on a stranger, save. */
function briefSteps(id: number, script: string, pageUrl: string | undefined): string {
  const draft = briefDraft(id);
  return `Lint until there are 0 errors, and fix most warnings: node ${script} lint --file ${draft}
Save it in place of the document, with the same id. The save refuses a spec with errors, and prints what changed since the last version:
node ${script} save --id ${id} --file ${draft}
${pageUrl ? `Look at it: open ${pageUrl} with agent-browser (if you have it), screenshot the page and each map view tab, and fix in the spec what a reader would trip over.\n` : ""}Then the cold-reader test (GUIDE.md, step 7): node ${script} text --id ${id} gives the page as text for a fresh subagent.
Do not post to Jira or Slack. ${User()} copies the TL;DR (node ${script} tldr --id ${id}) and downloads the HTML from the dashboard.`;
}

const RULES = `The document is markdown. Draw diagrams in \`\`\`mermaid fences. To embed a PNG, SVG, JPEG, GIF or WebP image, write ![alt](<path to the file>): the save stores a copy of the file in agent-dash and writes ![alt](image:<n>) in its place. Keep each ![alt](image:<n>) that is already there, unless the request is to remove it.`;

/** The first message of an agent that changes one document in place. A brief gets the brief tools: it is JSON, not markdown. */
export function editMessage(doc: { id: number; title: string; ticket: string | null; brief?: boolean }, prompt: string, script = DOCUMENT_SCRIPT, briefScript = BRIEF_SCRIPT, pageUrl?: string): string {
  const head = `Edit agent-dash document ${doc.id}, "${doc.title}"${doc.ticket ? ` on ${doc.ticket}` : ""}, as ${User()} asks:

<request>
${prompt.trim()}
</request>
`;
  if (doc.brief) {
    return `${head}
This document is a ticket brief: a JSON spec that agent-dash renders. Read ${BRIEF_GUIDE} first, and follow its update mode: change what the request asks, re-check the facts that the change touches (PR states, dates, ticket status), set verified_on to today, and change every place that repeats a date or a state that moved. Do not rewrite the rest.
Write the current spec to a file, and change it there:
node ${briefScript} show --id ${doc.id} > ${briefDraft(doc.id)}
${briefSteps(doc.id, briefScript, pageUrl)}
agent-dash shows the document as being edited until you save it. Then reply: first the "What changed" lines that the save printed, then one or two sentences on what you could not verify, and stop.`;
  }
  const file = draftFile(doc.id);
  return `${head}
Write the current document to a file, and read it:
node ${script} show --id ${doc.id} > ${file}
Change it as asked. Then save the whole new version in place of the old one, with the same id:
node ${script} save --id ${doc.id} --file ${file} [--title "<new title>"]
agent-dash shows the document as being edited until you save it. ${RULES}
Then reply with one or two sentences on what you changed, and stop.`;
}

/** The first message of an agent that writes a ticket's brief, whose empty row is `id`. */
export function ticketSummaryMessage(key: string, id: number, script = BRIEF_SCRIPT, pageUrl?: string): string {
  return `${TICKET_SUMMARY_PROMPT}

Read ${BRIEF_GUIDE} first, and follow it step by step: it says how to research (in parallel subagents, if you can start them), how to challenge the ticket, and how to write the spec. The research is read-only: no write to Jira, Slack, GitHub or any cloud account.

agent-dash made an empty brief (document ${id}) for ${key}, and shows it as being written until you save it. Start the spec from the skeleton:
node ${script} skeleton > ${briefDraft(id)}
${briefSteps(id, script, pageUrl)}
Then reply in two or three lines: what the brief says, what you could not verify, and what only a human can do. Then stop.`;
}
