import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { adfToMarkdown } from "../../shared/adf.ts";
import type { TicketDetail } from "../../shared/types.ts";
import { isDate } from "../../shared/jiraVerbs.ts";
import { config } from "../config.ts";
import { jiraGet, setJiraDueDate } from "../sources/jira.ts";
import { isLocalKey, localTicketDetail, readLocalTickets } from "../sources/localTickets.ts";

/** Comments shown inline; older ones stay in Jira, one click away. */
const COMMENTS = 10;

const cache = new Map<string, { at: number; value: TicketDetail }>();

/** Read-only: three GETs, for the fields, the newest comments, and the transitions. */
async function fetchDetail(key: string): Promise<TicketDetail> {
  const [issue, comments, transitions] = await Promise.all([
    jiraGet(`/rest/api/3/issue/${key}?fields=description,status,duedate`),
    // The issue's own comment field can cap at the oldest ones, so ask for the newest.
    jiraGet(`/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=${COMMENTS}`),
    jiraGet(`/rest/api/3/issue/${key}/transitions`).catch((err: Error) => err),
  ]);
  const f = issue.fields ?? {};
  return {
    key,
    status: f.status?.name ?? "?",
    dueDate: f.duedate ?? null,
    description: adfToMarkdown(f.description),
    comments: [...(comments.comments ?? [])].reverse().map((c: any) => ({ author: c.author?.displayName ?? "?", created: c.created ?? "", body: adfToMarkdown(c.body) })),
    commentTotal: comments.total ?? comments.comments?.length ?? 0,
    transitions: transitions instanceof Error ? [] : (transitions.transitions ?? []).map((t: any) => ({ id: String(t.id), name: t.name ?? "", to: t.to?.name ?? t.name ?? "" })),
    ...(transitions instanceof Error ? { transitionsError: transitions.message } : {}),
    fetchedAt: new Date().toISOString(),
  };
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

/**
 * Piper's click is the approval, so the page sends the due date it showed (`from`). If Jira
 * holds another one now, the click did not approve replacing it.
 */
async function setDueDate(key: string, date: string, from: string | null): Promise<{ status: number; body: unknown }> {
  const issue = await jiraGet(`/rest/api/3/issue/${key}?fields=duedate`);
  const current: string | null = issue.fields?.duedate ?? null;
  if (current !== from) return { status: 409, body: { error: `${key} is now due ${current ?? "never"}, not ${from ?? "never"}. Reload the ticket and pick the date again.` } };
  if (current !== date) await setJiraDueDate(key, date);
  cache.delete(key);
  return { status: 200, body: { key, from: current, dueDate: date } };
}

async function dueRoute(req: IncomingMessage, key: string, onDueDate: (key: string, date: string) => void): Promise<{ status: number; body: unknown }> {
  if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };
  let date: unknown, from: unknown;
  try {
    ({ date, from } = JSON.parse((await readBody(req, 4_000)) || "{}"));
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
  if (typeof date !== "string" || !isDate(date)) return { status: 400, body: { error: `not a date: ${String(date)}` } };
  if (from !== null && (typeof from !== "string" || !isDate(from))) return { status: 400, body: { error: "from must be the due date the page showed, or null" } };
  try {
    const out = await setDueDate(key, date, from);
    if (out.status === 200) onDueDate(key, date);
    return out;
  } catch (err) {
    return { status: 502, body: { error: (err as Error).message } };
  }
}

const localTicket = (key: string) => readLocalTickets(config.localTicketsDir, config.port).find((t) => t.key === key);

/** The ticket's link on the page: the file as plain text. It only reads a file that the folder scan found. */
function localFile(res: ServerResponse, url: URL): void {
  const t = localTicket(url.searchParams.get("key") ?? "");
  if (!t?.file) return void res.writeHead(404, { "Content-Type": "text/plain" }).end("no such ticket file");
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end(`${t.file}\n\n${readFileSync(t.file, "utf8")}`);
}

export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, onDueDate: (key: string, date: string) => void = () => {}): Promise<boolean> {
  if (url.pathname === "/api/local-ticket") {
    localFile(res, url);
    return true;
  }
  if (url.pathname !== "/api/ticket" && url.pathname !== "/api/ticket/due") return false;
  // Each call reaches Jira with Piper's token, so another web page must not trigger it.
  if (req.headers["x-agent-dash"] !== "1") {
    res.writeHead(403).end();
    return true;
  }
  const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  const key = url.searchParams.get("key") ?? "";
  // The key goes into a Jira URL, so only a real ticket key.
  if (!new RegExp(`^${config.ticketPattern.source}$`).test(key)) {
    json(400, { error: `not a ticket key: ${key}` });
    return true;
  }
  if (isLocalKey(key)) {
    const t = localTicket(key);
    if (url.pathname === "/api/ticket/due") json(400, { error: `${key} is a local ticket: it has no due date` });
    else if (!t) json(404, { error: `no ticket file for ${key}` });
    else json(200, localTicketDetail(t));
    return true;
  }
  if (url.pathname === "/api/ticket/due") {
    const { status, body } = await dueRoute(req, key, onDueDate);
    json(status, body);
    return true;
  }
  const hit = cache.get(key);
  if (hit && !url.searchParams.has("refresh") && Date.now() - hit.at < config.remoteTtlMs) {
    json(200, hit.value);
    return true;
  }
  try {
    const value = await fetchDetail(key);
    cache.set(key, { at: Date.now(), value });
    json(200, value);
  } catch (err) {
    json(502, { error: (err as Error).message });
  }
  return true;
}
