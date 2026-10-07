import type { IncomingMessage, ServerResponse } from "node:http";
import { MIME } from "../diagrams.ts";
import * as db from "../summaries/db.ts";

/**
 * `GET /api/diagram/raw?id=N`: the stored copy of a picture that an agent showed in a message, so
 * the message shows it after its file is gone. The picture's document is where you read and change it.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/diagram/raw" || req.method !== "GET") return false;
  const d = db.getDiagram(Number(url.searchParams.get("id")));
  if (!d?.source) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no such diagram" }));
    return true;
  }
  const body = d.kind === "mermaid" || d.kind === "svg" ? Buffer.from(d.source, "utf8") : Buffer.from(d.source, "base64");
  res
    .writeHead(200, {
      "Content-Type": MIME[d.kind],
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      "X-Content-Type-Options": "nosniff",
      // The source never changes, so each URL has one body.
      "Cache-Control": "private, max-age=31536000, immutable",
    })
    .end(body);
  return true;
}
