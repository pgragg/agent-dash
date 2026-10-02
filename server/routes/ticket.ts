import type { IncomingMessage, ServerResponse } from "node:http";
import { adfToMarkdown } from "../../shared/adf.ts";
import type { TicketDetail } from "../../shared/types.ts";
import { config } from "../config.ts";
import { jiraGet } from "../sources/jira.ts";

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

export async function handle(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/ticket") return false;
  const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  const key = url.searchParams.get("key") ?? "";
  // The key goes into a Jira URL, so only a real ticket key.
  if (!new RegExp(`^${config.ticketPattern.source}$`).test(key)) {
    json(400, { error: `not a ticket key: ${key}` });
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
