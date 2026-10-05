import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_TEXT, MIME, sniffImage } from "../diagrams.ts";
import type { DiagramWithSource } from "../../shared/types.ts";
import type { SessionIndex } from "../sources/sessions.ts";
import * as db from "../summaries/db.ts";

/**
 * `GET /api/diagram?id=N` and `GET /api/diagram/raw?id=N`: one diagram, as JSON or as its file.
 * `POST /api/diagram?id=N` with `{title?, source?, deleted?}`: fixes or deletes an agent's diagram.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, sessions: SessionIndex, onChange: () => void): Promise<boolean> {
  const isJson = url.pathname === "/api/diagram";
  if (!(isJson && (req.method === "GET" || req.method === "POST")) && !(url.pathname === "/api/diagram/raw" && req.method === "GET")) return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    return true;
  };
  if (req.method === "POST" && req.headers["x-agent-dash"] !== "1") return json(403, { error: "missing the X-Agent-Dash header" });
  const id = Number(url.searchParams.get("id"));
  const d = db.getDiagram(id, !isJson);
  if (!d) return json(404, { error: "no such diagram" });

  if (req.method === "POST") {
    let change: { title?: unknown; source?: unknown; deleted?: unknown };
    try {
      change = JSON.parse((await readBody(req, 2 * MAX_TEXT + 4_000)) || "{}");
    } catch {
      return json(400, { error: "send JSON, smaller than the size limit" });
    }
    const title = typeof change.title === "string" ? change.title.trim() : undefined;
    const source = typeof change.source === "string" ? change.source : undefined;
    const deleted = typeof change.deleted === "boolean" ? change.deleted : undefined;
    if (title === undefined && source === undefined && deleted === undefined) return json(400, { error: "send a title, a source, or deleted" });
    if (title !== undefined && (!title || title.length > 200)) return json(400, { error: "a title needs 1 to 200 characters" });
    if (source !== undefined) {
      if (d.kind !== "mermaid" && d.kind !== "svg") return json(400, { error: `a ${d.kind} image has no text to edit` });
      if (!source.trim() || source.length > MAX_TEXT) return json(400, { error: `the source needs 1 to ${MAX_TEXT} characters` });
      // The raw route serves it as image/svg+xml, so it must stay an SVG.
      if (d.kind === "svg" && sniffImage(Buffer.from(source)) !== "svg") return json(400, { error: "the source is not an SVG" });
    }
    db.updateDiagram(id, { title, source, deleted });
    onChange();
    return json(200, withConversation(db.getDiagram(id)!, sessions));
  }

  if (isJson) return json(200, withConversation(d, sessions));
  const body = d.kind === "mermaid" || d.kind === "svg" ? Buffer.from(d.source!, "utf8") : Buffer.from(d.source!, "base64");
  res
    .writeHead(200, {
      "Content-Type": MIME[d.kind],
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      "X-Content-Type-Options": "nosniff",
      // The page asks for an edited diagram with its edit time in the URL, so each URL has one body.
      "Cache-Control": "private, max-age=31536000, immutable",
    })
    .end(body);
  return true;
}

function withConversation(d: db.StoredDiagram, sessions: SessionIndex): DiagramWithSource {
  const s = sessions.peek(d.sessionId);
  return { ...d, conversation: s ? { title: s.name ?? s.firstPrompt, cwd: s.cwd, startedAt: s.startedAt, lastActivityAt: s.lastActivityAt } : null };
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
