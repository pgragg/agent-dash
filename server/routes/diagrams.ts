import type { IncomingMessage, ServerResponse } from "node:http";
import { MIME } from "../diagrams.ts";
import type { DiagramWithSource } from "../../shared/types.ts";
import type { SessionIndex } from "../sources/sessions.ts";
import * as db from "../summaries/db.ts";

/** `GET /api/diagram?id=N` and `GET /api/diagram/raw?id=N`: one diagram, as JSON or as its file. */
export async function handle(_req: IncomingMessage, res: ServerResponse, url: URL, sessions: SessionIndex): Promise<boolean> {
  if (url.pathname !== "/api/diagram" && url.pathname !== "/api/diagram/raw") return false;
  const d = db.getDiagram(Number(url.searchParams.get("id")));
  if (!d) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no such diagram" }));
    return true;
  }
  if (url.pathname === "/api/diagram") {
    const text = d.kind === "mermaid" || d.kind === "svg";
    const s = (await sessions.scan()).find((p) => p.sessionId === d.sessionId);
    const conversation = s ? { title: s.name ?? s.firstPrompt, cwd: s.cwd, startedAt: s.startedAt, lastActivityAt: s.lastActivityAt } : null;
    const body: DiagramWithSource = { ...d, source: text ? d.source : null, conversation };
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    return true;
  }
  const body = d.kind === "mermaid" || d.kind === "svg" ? Buffer.from(d.source, "utf8") : Buffer.from(d.source, "base64");
  res
    .writeHead(200, {
      "Content-Type": MIME[d.kind],
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      "X-Content-Type-Options": "nosniff",
      // A diagram never changes: a new version is a new row.
      "Cache-Control": "private, max-age=31536000, immutable",
    })
    .end(body);
  return true;
}
