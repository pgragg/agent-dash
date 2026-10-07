import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { config } from "../config.ts";
import { startConversation } from "../conversations.ts";
import { MIME } from "../diagrams.ts";
import { DOCUMENT_SCRIPT, editMessage, TICKET_SUMMARY_PROMPT, ticketSummaryMessage } from "../documents.ts";
import { agentMessage, agentName } from "../handoff.ts";
import * as db from "../summaries/db.ts";

export interface DocumentDeps {
  /** The handoff context of a ticket, for a new agent. Null for a ticket the dash does not show. */
  context: (key: string) => Promise<string | null>;
  onChange: () => void;
  /** Tests start no agent. */
  start?: typeof startConversation;
  script?: string;
}

/**
 * `GET /api/document?id=N`: one document with its body. `DELETE /api/document?id=N` deletes it. `GET /api/document/image?id=N`: an image in one.
 * `POST /api/document/edit?id=N` with `{ prompt, cwd }`: an agent changes the document in place.
 * `DELETE /api/document/edit?id=N`: ends an edit that will not save.
 * `POST /api/document/ticket-summary?ticket=KEY` with `{ cwd }`: an agent writes the ticket's ticket summary.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, deps: DocumentDeps): Promise<boolean> {
  if (!url.pathname.startsWith("/api/document")) return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    return true;
  };
  const id = Number(url.searchParams.get("id"));

  if (url.pathname === "/api/document" && req.method === "GET") {
    const doc = db.getDocument(id);
    return doc ? json(200, doc) : json(404, { error: "no such document" });
  }
  if (url.pathname === "/api/document" && req.method === "DELETE") {
    if (req.headers["x-agent-dash"] !== "1") return json(403, { error: "missing the X-Agent-Dash header" });
    const ok = db.deleteDocument(id);
    if (ok) deps.onChange();
    return ok ? json(200, { ok }) : json(404, { error: "no such document" });
  }
  if (url.pathname === "/api/document/image" && req.method === "GET") {
    const img = db.getDocumentImage(id);
    if (!img) return json(404, { error: "no such image" });
    res
      .writeHead(200, {
        "Content-Type": MIME[img.kind],
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        "X-Content-Type-Options": "nosniff",
        // A new version of a document gets a new image row, so each id has one body.
        "Cache-Control": "private, max-age=31536000, immutable",
      })
      .end(img.kind === "svg" ? Buffer.from(img.data, "utf8") : Buffer.from(img.data, "base64"));
    return true;
  }

  const editing = url.pathname === "/api/document/edit" && (req.method === "POST" || req.method === "DELETE");
  const summarizing = url.pathname === "/api/document/ticket-summary" && req.method === "POST";
  if (!editing && !summarizing) return false;
  // These start a paid agent run, so the same CSRF guard as the other POST routes.
  if (req.headers["x-agent-dash"] !== "1") return json(403, { error: "missing the X-Agent-Dash header" });

  if (editing && req.method === "DELETE") {
    const ok = db.clearDocumentEdit(id);
    if (ok) deps.onChange();
    return ok ? json(200, { ok }) : json(404, { error: "no edit is waiting on that document" });
  }

  let body: { prompt?: unknown; cwd?: unknown };
  try {
    body = JSON.parse((await readBody(req, 64_000)) || "{}");
  } catch {
    return json(400, { error: "send JSON, smaller than the size limit" });
  }
  const dir = (typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : "~").replace(/^~(?=\/|$)/, homedir());
  if (!dir.startsWith("/") || !existsSync(dir) || !statSync(dir).isDirectory()) return json(400, { error: `not a folder: ${String(body.cwd)}` });
  const start = deps.start ?? startConversation;
  const script = deps.script ?? DOCUMENT_SCRIPT;
  const sessionId = randomUUID();

  if (editing) {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return json(400, { error: "write what to change" });
    const doc = db.getDocument(id);
    if (!doc) return json(404, { error: "no such document" });
    const context = doc.ticket ? await deps.context(doc.ticket) : null;
    if (!db.startDocumentEdit(id, prompt, sessionId)) return json(409, { error: "an agent already edits this document: wait for its save, or cancel it" });
    const undo = () => {
      if (db.clearDocumentEdit(id)) deps.onChange();
    };
    const message = editMessage(doc, prompt, script);
    const label = `Edit document ${id}: ${prompt}`;
    return launch(() => start({ cwd: dir, message: context ? agentMessage(context, message) : message, name: doc.ticket ? agentName(doc.ticket, label) : label.slice(0, 70), sessionId, onSpawnError: undo }), undo);
  }

  const key = url.searchParams.get("ticket") ?? "";
  if (!new RegExp(`^${config.ticketPattern.source}$`).test(key)) return json(400, { error: `not a ticket key: ${key}` });
  const context = await deps.context(key);
  if (context === null) return json(404, { error: `the dash does not show ${key}, so it cannot start an agent for it` });
  const doc = db.addDocument({ ticket: key, type: "ticket-summary", title: "Ticket summary", body: "", edit: { prompt: TICKET_SUMMARY_PROMPT, sessionId } });
  if (!doc) return json(409, { error: `${key} already has a ticket summary` });
  const undo = () => {
    if (db.clearDocumentEdit(doc.id)) deps.onChange();
  };
  return launch(() => start({ cwd: dir, message: agentMessage(context, ticketSummaryMessage(key, doc.id, script)), name: agentName(key, "Write the ticket summary"), sessionId, onSpawnError: undo }), undo, doc.id);

  function launch(run: () => unknown, undo: () => void, documentId = id): boolean {
    try {
      run();
    } catch (err) {
      undo();
      return json(500, { error: (err as Error).message });
    }
    deps.onChange();
    return json(201, { ok: true, sessionId, documentId });
  }
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > max) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
