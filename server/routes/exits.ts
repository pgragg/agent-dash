import type { IncomingMessage, ServerResponse } from "node:http";
import { parseExit, parseUsage } from "../../shared/exits.ts";
import { config } from "../config.ts";
import { exitCounts, recordExit, recordUsage } from "../exits.ts";

// An exit row is a few short strings; anything bigger is not from the page.
const MAX_BODY = 2_000;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      if (!tooBig) body += chunk;
      if (body.length > MAX_BODY) tooBig = true;
    });
    req.on("end", () => resolve(tooBig ? null : body));
    req.on("error", () => resolve(null));
  });
}

/** `POST /api/exits` records one exit; `GET /api/exits?days=7` counts them. `POST /api/usage` records one usage row. */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const usage = url.pathname === "/api/usage";
  if (!usage && url.pathname !== "/api/exits") return false;
  const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  if (req.method === "GET" && !usage) {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 7));
    json(200, { days, counts: exitCounts(days) });
  } else if (req.method !== "POST") {
    res.writeHead(405, { Allow: usage ? "POST" : "GET, POST" }).end();
  } else if (req.headers["x-agent-dash"] !== "1") {
    // Same CSRF guard as /api/focus: a custom header forces a preflight that is never answered.
    res.writeHead(403).end();
  } else {
    const raw = await readBody(req);
    let body: unknown = null;
    try {
      body = raw === null ? null : JSON.parse(raw);
    } catch {}
    const row = usage ? parseUsage(body, config.ticketPattern) : null;
    const exit = usage ? null : parseExit(body, config.ticketPattern);
    if (raw === null) json(413, { error: "body too large" });
    else if (usage) {
      if (row) recordUsage(row);
      json(row ? 201 : 400, row ? { ok: true } : { error: "not a valid usage row" });
    }
    // The focus endpoint records iTerm exits itself, so the page cannot count one twice.
    else if (!exit || exit.kind === "iterm_focus") json(400, { error: "not a valid exit" });
    else {
      recordExit(exit);
      json(201, { ok: true });
    }
  }
  return true;
}
