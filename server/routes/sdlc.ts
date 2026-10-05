import type { IncomingMessage, ServerResponse } from "node:http";
import type { PullRequest } from "../../shared/types.ts";
import { config } from "../config.ts";
import { validateSdlcEvent } from "../sdlc.ts";
import { fetchTicketPrs } from "../sources/github.ts";
import * as db from "../summaries/db.ts";

const prCache = new Map<string, { at: number; value: PullRequest[] }>();

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

/**
 * `GET /api/ticket-prs?key=KEY`: the ticket's PRs on GitHub, for the SDLC progress bar.
 * `POST /api/sdlc-events` and `DELETE /api/sdlc-events?id=N`: record or remove a smoketest or a deploy.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, onChange: () => void): Promise<boolean> {
  if (url.pathname !== "/api/ticket-prs" && url.pathname !== "/api/sdlc-events") return false;
  // The PR search runs gh with Piper's login, and the others write: another web page must not call them.
  if (req.headers["x-agent-dash"] !== "1") {
    res.writeHead(403).end();
    return true;
  }
  const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));

  if (url.pathname === "/api/ticket-prs") {
    const key = url.searchParams.get("key") ?? "";
    // The key goes into a GitHub search, so only a real ticket key.
    if (!new RegExp(`^${config.ticketPattern.source}$`).test(key)) {
      json(400, { error: `not a ticket key: ${key}` });
      return true;
    }
    const hit = prCache.get(key);
    if (hit && !url.searchParams.has("refresh") && Date.now() - hit.at < config.remoteTtlMs) {
      json(200, hit.value);
      return true;
    }
    try {
      const value = await fetchTicketPrs(key, config.ticketPattern);
      prCache.set(key, { at: Date.now(), value });
      json(200, value);
    } catch (err) {
      json(502, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "DELETE") {
    const ok = db.deleteSdlcEvent(Number(url.searchParams.get("id")));
    if (ok) onChange();
    json(ok ? 200 : 404, ok ? { ok } : { error: "no such event" });
    return true;
  }
  if (req.method !== "POST") {
    json(405, { error: "POST or DELETE" });
    return true;
  }
  try {
    const event = db.addSdlcEvent(validateSdlcEvent(JSON.parse((await readBody(req, 64_000)) || "{}"), config.ticketPattern));
    onChange();
    json(201, event);
  } catch (err) {
    json(400, { error: (err as Error).message });
  }
  return true;
}
