import type { IncomingMessage, ServerResponse } from "node:http";
import { isDate } from "../../shared/jiraVerbs.ts";
import { config } from "../config.ts";
import type { OnTicketChange, VerbResult } from "../tickets/provider.ts";
import { type TicketProviders, ticketProviders } from "../tickets/registry.ts";

export type { OnTicketChange } from "../tickets/provider.ts";

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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | VerbResult> {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };
  try {
    return JSON.parse((await readBody(req, 4_000)) || "{}");
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
}

const isResult = (x: unknown): x is VerbResult => !!x && typeof x === "object" && "status" in x && "body" in x && typeof (x as VerbResult).status === "number";

/** A status move, with the status the page showed (`from`): the click approved a move from that status only. */
async function moveRoute(req: IncomingMessage, key: string, providers: TicketProviders, onChange: OnTicketChange): Promise<VerbResult> {
  const input = await readJson(req);
  if (isResult(input)) return input;
  const { to, from } = input;
  if (typeof to !== "string" || !to.trim()) return { status: 400, body: { error: "to must be a status name" } };
  if (typeof from !== "string") return { status: 400, body: { error: "from must be the status the page showed" } };
  const p = providers.providerFor(key);
  if (!p?.move) return { status: 400, body: { error: `${key}: ${p?.source.label ?? "no tracker"} cannot move a ticket from agent-dash` } };
  return p.move(key, to, from, onChange);
}

/** A due date, with the date the page showed (`from`): the click did not approve replacing another one. */
async function dueRoute(req: IncomingMessage, key: string, providers: TicketProviders, onChange: OnTicketChange): Promise<VerbResult> {
  const input = await readJson(req);
  if (isResult(input)) return input;
  const { date, from } = input;
  if (typeof date !== "string" || !isDate(date)) return { status: 400, body: { error: `not a date: ${String(date)}` } };
  if (from !== null && (typeof from !== "string" || !isDate(from))) return { status: 400, body: { error: "from must be the due date the page showed, or null" } };
  const p = providers.providerFor(key);
  if (!p?.setDueDate) return { status: 400, body: { error: `${key}: ${p?.source.label ?? "no tracker"} has no due date that agent-dash can set` } };
  return p.setDueDate(key, date, from, onChange);
}

/** The ticket's link on the page, for a tracker with no web page: the ticket as plain text. */
function rawTicket(res: ServerResponse, url: URL, providers: TicketProviders): void {
  const key = url.searchParams.get("key") ?? "";
  const text = providers.providerFor(key)?.rawText?.(key) ?? null;
  if (text === null) return void res.writeHead(404, { "Content-Type": "text/plain" }).end("no such ticket file");
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end(text);
}

export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, onChange: OnTicketChange = () => {}, providers = ticketProviders): Promise<boolean> {
  if (url.pathname === "/api/local-ticket") {
    rawTicket(res, url, providers);
    return true;
  }
  if (url.pathname !== "/api/ticket" && url.pathname !== "/api/ticket/due" && url.pathname !== "/api/ticket/move") return false;
  // A call can reach a tracker with Piper's token, so another web page must not trigger it.
  if (req.headers["x-agent-dash"] !== "1") {
    res.writeHead(403).end();
    return true;
  }
  const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  const key = url.searchParams.get("key") ?? "";
  // The key goes into a tracker URL or a file name, so only a real ticket key.
  if (!new RegExp(`^${config.ticketPattern.source}$`).test(key)) {
    json(400, { error: `not a ticket key: ${key}` });
    return true;
  }
  try {
    if (url.pathname === "/api/ticket/due") {
      const { status, body } = await dueRoute(req, key, providers, onChange);
      json(status, body);
    } else if (url.pathname === "/api/ticket/move") {
      const { status, body } = await moveRoute(req, key, providers, onChange);
      json(status, body);
    } else {
      const p = providers.providerFor(key);
      const detail = p ? await p.detail(key, url.searchParams.has("refresh")) : null;
      if (detail) json(200, detail);
      else json(404, { error: `no ticket ${key} in ${p?.source.label ?? "any tracker"}` });
    }
  } catch (err) {
    json(502, { error: (err as Error).message });
  }
  return true;
}
