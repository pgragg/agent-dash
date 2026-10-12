import { splitList, type TicketProviderSettings } from "../../shared/settings.ts";

/** One row of the Ticket providers card: every field as the text in its box, for either type. */
export interface ProviderRow {
  type: "jira" | "local";
  id: string;
  server: string;
  login: string;
  tokenFile: string;
  excludeProjects: string;
  projects: string;
  prefix: string;
  dir: string;
}

export const emptyRow = (type: ProviderRow["type"]): ProviderRow => ({ type, id: "", server: "", login: "", tokenFile: "", excludeProjects: "", projects: "", prefix: "", dir: "" });

export const rowOf = (p: TicketProviderSettings): ProviderRow =>
  p.type === "jira"
    ? { ...emptyRow("jira"), id: p.id ?? "", server: p.server, login: p.login, tokenFile: p.tokenFile, excludeProjects: p.excludeProjects.join(", "), projects: p.projects.join(", ") }
    : { ...emptyRow("local"), id: p.id ?? "", prefix: p.prefix, dir: p.dir };

/** What Save sends for a row: only its type's fields, and no id when the box is empty. The server checks it. */
export function providerOf(r: ProviderRow): Record<string, unknown> {
  const id = r.id.trim() ? { id: r.id.trim() } : {};
  return r.type === "jira"
    ? { type: "jira", ...id, server: r.server, login: r.login, tokenFile: r.tokenFile, excludeProjects: splitList(r.excludeProjects), projects: splitList(r.projects) }
    : { type: "local", ...id, prefix: r.prefix.trim(), dir: r.dir };
}

/** The rows that the flat Jira fields and the local tickets folder make, as the server does without a list. */
export function rowsFromFlat(d: Record<string, string>): ProviderRow[] {
  return [
    ...(d.jiraServer?.trim() ? [{ ...emptyRow("jira"), server: d.jiraServer, login: d.jiraLogin ?? "", tokenFile: d.jiraTokenFile ?? "", excludeProjects: d.jiraExcludeProjects ?? "" }] : []),
    ...(d.localTicketsDir?.trim() ? [{ ...emptyRow("local"), prefix: "AD", dir: d.localTicketsDir }] : []),
  ];
}
