import { readFileSync } from "node:fs";
import type { Ticket } from "../../shared/types.ts";
import { config } from "../config.ts";

const FIELDS = ["summary", "status", "priority", "duedate", "updated", "assignee"];

function token(): string {
  if (process.env.JIRA_API_TOKEN) return process.env.JIRA_API_TOKEN;
  if (!config.jira.tokenFile) throw new Error("no Jira token: set JIRA_API_TOKEN, or the Jira token file on the Settings page");
  const line = readFileSync(config.jira.tokenFile, "utf8")
    .split("\n")
    .find((l) => /^(export\s+)?JIRA_API_TOKEN=/.test(l));
  if (!line) throw new Error(`JIRA_API_TOKEN not found in ${config.jira.tokenFile}`);
  return line.replace(/^(export\s+)?JIRA_API_TOKEN=/, "").replace(/^["']|["']$/g, "").trim();
}

/** The Jira server, or an error that the source health shows when none is set. */
function jiraUrl(path: string): string {
  if (!config.jira.server) throw new Error("Jira is not set up: set the Jira server on the Settings page");
  return `${config.jira.server}${path}`;
}

function basicAuth(): string {
  return `Basic ${Buffer.from(`${config.jira.login}:${token()}`).toString("base64")}`;
}

/** A read-only GET on the Jira REST API, such as `/rest/api/3/issue/KEY`. */
export async function jiraGet(path: string): Promise<any> {
  const res = await fetch(jiraUrl(path), {
    headers: { Authorization: basicAuth(), Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** One of the two Jira writes the dash makes itself. Jira answers 204. */
async function jiraWrite(method: "PUT" | "POST", path: string, body: unknown): Promise<void> {
  const res = await fetch(jiraUrl(path), {
    method,
    headers: { Authorization: basicAuth(), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export const setJiraDueDate = (key: string, date: string) => jiraWrite("PUT", `/rest/api/3/issue/${key}`, { fields: { duedate: date } });

export const transitionJiraIssue = (key: string, id: string, fields: Record<string, unknown>) =>
  jiraWrite("POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id }, ...(Object.keys(fields).length ? { fields } : {}) });

/** Read-only: POST /search/jql is a query, not a write. */
async function search(jql: string): Promise<any[]> {
  const issues: any[] = [];
  let nextPageToken: string | undefined;
  do {
    const res = await fetch(jiraUrl("/rest/api/3/search/jql"), {
      method: "POST",
      headers: { Authorization: basicAuth(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jql, fields: FIELDS, maxResults: 100, nextPageToken }),
      signal: AbortSignal.timeout(20_000),
    });
    // jira-cli reports a 401 as an empty result. Fail loudly so an empty list is never a lie.
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { issues?: any[]; nextPageToken?: string; isLast?: boolean };
    issues.push(...(body.issues ?? []));
    nextPageToken = body.isLast === false ? body.nextPageToken : undefined;
  } while (nextPageToken);
  return issues;
}

function toTicket(issue: any, me: boolean): Ticket {
  const f = issue.fields ?? {};
  return {
    key: issue.key,
    url: `${config.jira.server}/browse/${issue.key}`,
    summary: f.summary ?? "",
    status: f.status?.name ?? "?",
    statusCategory: f.status?.statusCategory?.key ?? "new",
    priority: f.priority?.name ?? null,
    dueDate: f.duedate ?? null,
    updatedAt: f.updated ?? "",
    assignedToMe: me,
  };
}

export async function fetchMyTickets(): Promise<Ticket[]> {
  // Naming a project in the JQL also stops jira's default-project scoping from applying.
  const exclude = config.jira.excludeProjects.length ? `project NOT IN (${config.jira.excludeProjects.join(",")}) AND ` : "";
  const issues = await search(`${exclude}assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`);
  return issues.map((i) => toTicket(i, true));
}

/** Tickets that runs or PRs name but that are not on my open list. */
export async function fetchTickets(keys: string[]): Promise<Ticket[]> {
  if (keys.length === 0) return [];
  const out: Ticket[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    // An unknown key fails the whole JQL, so a typo in a log cannot hide the rest.
    const issues = await search(`issuekey IN (${chunk.join(",")})`).catch(async () => {
      const each = await Promise.all(chunk.map((k) => search(`issuekey = ${k}`).catch(() => [])));
      return each.flat();
    });
    out.push(...issues.map((i) => toTicket(i, false)));
  }
  return out;
}
