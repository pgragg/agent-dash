import type { IncomingMessage, ServerResponse } from "node:http";
import { parseExit } from "../../shared/exits.ts";
import { config } from "../config.ts";
import { exitCounts, recordExit } from "../exits.ts";

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

/** `POST /api/exits` records one exit; `GET /api/exits?days=7` counts them. */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/exits") return false;
  const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  if (req.method === "GET") {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 7));
    json(200, { days, counts: exitCounts(days) });
    return true;
  }
  if (req.method !== "POST") return json(405, { error: "GET or POST" }), true;
  // Same CSRF guard as /api/focus: a custom header forces a preflight that is never answered.
  if (req.headers["x-agent-dash"] !== "1") return res.writeHead(403).end(), true;
  const raw = await readBody(req);
  if (raw === null) return json(413, { error: "body too large" }), true;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "not JSON" }), true;
  }
  const exit = parseExit(body, config.ticketPattern);
  if (!exit) return json(400, { error: "unknown exit kind" }), true;
  // The focus endpoint records iTerm exits itself, so the page cannot count one twice.
  if (exit.kind === "iterm_focus") return json(400, { error: "iterm_focus is recorded by /api/focus" }), true;
  recordExit(exit);
  json(201, { ok: true });
  return true;
}
