import { readFileSync } from "node:fs";
import { adfToMarkdown } from "../../shared/adf.ts";
import { defaultDueDate, moveTargets, type ScreenField, screenFields } from "../../shared/jiraVerbs.ts";
import type { Ticket, TicketDetail, TicketSource } from "../../shared/types.ts";
import type { OnTicketChange, TicketProvider, VerbResult } from "./provider.ts";

export interface JiraProviderConfig {
  id: string;
  server: string;
  login: string;
  tokenFile: string;
  excludeProjects: string[];
  projects: string[];
}

const FIELDS = ["summary", "status", "priority", "duedate", "updated", "assignee"];
/** Comments shown inline; older ones stay in Jira, one click away. */
const COMMENTS = 10;

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** A Jira site, read with the REST API. Its two writes, a due date and a status move, need Piper's click. */
export class JiraProvider implements TicketProvider {
  readonly source: TicketSource;
  readonly prefixes: string[] | null;
  readonly enabled: boolean;
  readonly exhaustive = false;
  private readonly cfg: JiraProviderConfig;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { at: number; value: TicketDetail }>();

  constructor(cfg: JiraProviderConfig, ttlMs: number) {
    this.cfg = cfg;
    this.ttlMs = ttlMs;
    this.source = { id: cfg.id, label: "Jira", dueDate: true, move: true };
    this.prefixes = cfg.projects.length ? cfg.projects : null;
    // With no server or login it is off, not down.
    this.enabled = !!(cfg.server && cfg.login);
  }

  private token(): string {
    if (process.env.JIRA_API_TOKEN) return process.env.JIRA_API_TOKEN;
    if (!this.cfg.tokenFile) throw new Error("no Jira token: set JIRA_API_TOKEN, or the Jira token file on the Settings page");
    const line = readFileSync(this.cfg.tokenFile, "utf8")
      .split("\n")
      .find((l) => /^(export\s+)?JIRA_API_TOKEN=/.test(l));
    if (!line) throw new Error(`JIRA_API_TOKEN not found in ${this.cfg.tokenFile}`);
    return line.replace(/^(export\s+)?JIRA_API_TOKEN=/, "").replace(/^["']|["']$/g, "").trim();
  }

  /** The Jira URL, or an error that the source health shows when no server is set. */
  private url(path: string): string {
    if (!this.cfg.server) throw new Error("Jira is not set up: set the Jira server on the Settings page");
    return `${this.cfg.server}${path}`;
  }

  private auth(): string {
    return `Basic ${Buffer.from(`${this.cfg.login}:${this.token()}`).toString("base64")}`;
  }

  /** A read-only GET on the Jira REST API, such as `/rest/api/3/issue/KEY`. */
  private async get(path: string): Promise<any> {
    const res = await fetch(this.url(path), { headers: { Authorization: this.auth(), Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  /** One of the two Jira writes the dash makes itself. Jira answers 204. */
  private async write(method: "PUT" | "POST", path: string, body: unknown): Promise<void> {
    const res = await fetch(this.url(path), {
      method,
      headers: { Authorization: this.auth(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  private putDueDate = (key: string, date: string) => this.write("PUT", `/rest/api/3/issue/${key}`, { fields: { duedate: date } });

  private transition = (key: string, id: string, fields: Record<string, unknown>) =>
    this.write("POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id }, ...(Object.keys(fields).length ? { fields } : {}) });

  /** Read-only: POST /search/jql is a query, not a write. */
  private async search(jql: string): Promise<any[]> {
    const issues: any[] = [];
    let nextPageToken: string | undefined;
    do {
      const res = await fetch(this.url("/rest/api/3/search/jql"), {
        method: "POST",
        headers: { Authorization: this.auth(), "Content-Type": "application/json", Accept: "application/json" },
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

  private toTicket(issue: any, me: boolean): Ticket {
    const f = issue.fields ?? {};
    return {
      key: issue.key,
      url: this.ticketUrl(issue.key),
      summary: f.summary ?? "",
      status: f.status?.name ?? "?",
      statusCategory: f.status?.statusCategory?.key ?? "new",
      priority: f.priority?.name ?? null,
      dueDate: f.duedate ?? null,
      updatedAt: f.updated ?? "",
      assignedToMe: me,
      source: this.source,
    };
  }

  ticketUrl(key: string): string {
    return `${this.cfg.server}/browse/${key}`;
  }

  async listMine(): Promise<Ticket[]> {
    // Naming a project in the JQL also stops jira's default-project scoping from applying.
    const exclude = this.cfg.excludeProjects.length ? `project NOT IN (${this.cfg.excludeProjects.join(",")}) AND ` : "";
    const issues = await this.search(`${exclude}assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`);
    return issues.map((i) => this.toTicket(i, true));
  }

  async lookup(keys: string[]): Promise<Ticket[]> {
    const out: Ticket[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      // An unknown key fails the whole JQL, so a typo in a log cannot hide the rest.
      const issues = await this.search(`issuekey IN (${chunk.join(",")})`).catch(async () => {
        const each = await Promise.all(chunk.map((k) => this.search(`issuekey = ${k}`).catch(() => [])));
        return each.flat();
      });
      out.push(...issues.map((i) => this.toTicket(i, false)));
    }
    return out;
  }

  /** Read-only: three GETs, for the fields, the newest comments, and the transitions. */
  async detail(key: string, refresh: boolean): Promise<TicketDetail> {
    const hit = this.cache.get(key);
    if (hit && !refresh && Date.now() - hit.at < this.ttlMs) return hit.value;
    const [issue, comments, transitions] = await Promise.all([
      this.get(`/rest/api/3/issue/${key}?fields=description,status,duedate`),
      // The issue's own comment field can cap at the oldest ones, so ask for the newest.
      this.get(`/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=${COMMENTS}`),
      this.get(`/rest/api/3/issue/${key}/transitions`).catch((err: Error) => err),
    ]);
    const f = issue.fields ?? {};
    const value: TicketDetail = {
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
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  agentReadStep(key: string): string {
    const source = this.cfg.tokenFile ? `set -a; source ${shellQuote(this.cfg.tokenFile)}; set +a; ` : "";
    return `2. Jira body and comments:\n   ${source}jira issue view ${key} --comments 20 --plain`;
  }

  /**
   * Piper's click is the approval, so the page sends the due date it showed (`from`). If Jira
   * holds another one now, the click did not approve replacing it.
   */
  async setDueDate(key: string, date: string, from: string | null, onChange: OnTicketChange): Promise<VerbResult> {
    const issue = await this.get(`/rest/api/3/issue/${key}?fields=duedate`);
    const current: string | null = issue.fields?.duedate ?? null;
    if (current !== from) return { status: 409, body: { error: `${key} is now due ${current ?? "never"}, not ${from ?? "never"}. Reload the ticket and pick the date again.` } };
    if (current !== date) await this.putDueDate(key, date);
    this.cache.delete(key);
    onChange(key, { dueDate: date });
    return { status: 200, body: { key, from: current, dueDate: date } };
  }

  /** The transitions Jira offers now, the one to `to` with its screen fields filled, and the issue. */
  private async readHop(key: string, to: string) {
    const all: any[] = (await this.get(`/rest/api/3/issue/${key}/transitions?expand=transitions.fields`)).transitions ?? [];
    const t = all.find((x) => x.to?.name === to) ?? null;
    const screen: ScreenField[] = Object.entries(t?.fields ?? {}).map(([k, v]: [string, any]) => ({ key: k, type: v?.schema?.type ?? "" }));
    const issue = (await this.get(`/rest/api/3/issue/${key}?fields=${["status", "duedate", ...screen.map((f) => f.key)].join(",")}`)).fields ?? {};
    return { all, t, issue, status: (issue.status?.name ?? "?") as string, fields: screenFields(screen, issue, new Date()) };
  }

  /**
   * A status move, with the status the page showed (`from`): the click approved a move from that
   * status only. It walks two transitions where `moveTargets` says so, as the jira-tickets skill does.
   */
  async move(key: string, to: string, from: string, onChange: OnTicketChange): Promise<VerbResult> {
    const first = await this.readHop(key, to);
    if (first.status !== from) return { status: 409, body: { error: `${key} is now "${first.status}". Reload the ticket and pick the status again.` } };
    const target = moveTargets(first.all.map((x) => ({ to: x.to?.name ?? "" })), first.status).find((m) => m.to === to);
    if (!target) return { status: 409, body: { error: `${key} cannot move from "${first.status}" to "${to}".` } };
    let hop = target.via ? await this.readHop(key, target.via) : first;
    // A ticket that starts work gets a due date first, also when no screen asks for one.
    let dueDate: string | null = (hop.fields.duedate as string | undefined) ?? hop.issue.duedate ?? null;
    if (!dueDate && (target.via || hop.t.to?.statusCategory?.key === "indeterminate")) await this.putDueDate(key, (dueDate = defaultDueDate(new Date())));
    await this.transition(key, String(hop.t.id), hop.fields);
    this.cache.delete(key);
    if (target.via) {
      hop = await this.readHop(key, to);
      if (!hop.t) {
        onChange(key, { status: target.via, dueDate });
        return { status: 502, body: { error: `${key} is now "${target.via}", but Jira offers no move from there to "${to}".` } };
      }
      await this.transition(key, String(hop.t.id), hop.fields);
    }
    onChange(key, { status: to, statusCategory: hop.t.to?.statusCategory?.key ?? "indeterminate", dueDate });
    return { status: 200, body: { key, from, to, dueDate } };
  }
}
