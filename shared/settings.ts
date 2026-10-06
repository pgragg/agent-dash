import { DEFAULT_TEAM, type Team } from "./team.ts";

/**
 * The per-user settings in `agent-dash.config.json`. One list of fields drives the server's
 * defaults, env overrides and validation, and the Settings page's form. Free of Node and React.
 */

export interface Settings extends Team {
  port: number;
  sessionsDir: string;
  recentDays: number;
  jiraServer: string;
  jiraLogin: string;
  jiraTokenFile: string;
  jiraExcludeProjects: string[];
  ticketProjects: string[];
  ignoreTickets: string[];
  localTicketsDir: string;
  piAuth: string;
  slackStateFile: string;
  slackOrgId: string;
  slackWorkspaceUrl: string;
  slackReloginCommand: string;
  smoketestGuide: string;
}

export type SettingKey = keyof Settings;

export interface SettingField {
  key: SettingKey;
  group: "You" | "Server" | "Jira" | "Tickets" | "Reviews" | "Deploys" | "Logins" | "Slack" | "Smoketests";
  label: string;
  kind: "number" | "text" | "path" | "url" | "list";
  /** A list value must match this; a text value too, when it is not empty. */
  pattern?: RegExp;
  /** An env var that wins over the file, for a test server or a one-off run. */
  env?: string;
  help: string;
}

/**
 * Company-wide values are defaults, so a colleague sets only their own: the Jira login and token,
 * ticket projects, and the paths on their machine.
 */
export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_TEAM,
  port: 7777,
  sessionsDir: "~/.pi/agent/sessions",
  recentDays: 14,
  jiraServer: "https://postmanlabs.atlassian.net",
  jiraLogin: "",
  jiraTokenFile: "",
  jiraExcludeProjects: [],
  ticketProjects: [],
  ignoreTickets: [],
  localTicketsDir: "",
  piAuth: "",
  slackStateFile: "",
  slackOrgId: "E071JP7HM0C",
  slackWorkspaceUrl: "https://postman.enterprise.slack.com",
  slackReloginCommand: "",
  smoketestGuide: "",
};

const PROJECT = /^[A-Z][A-Z0-9]*$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export const SETTING_FIELDS: SettingField[] = [
  { key: "userName", group: "You", label: "Your first name", kind: "text", pattern: /^[^\s"'`]{1,40}$/, help: "Agents call you by this name in the prompts that agent-dash writes. Empty: \"the user\"." },
  { key: "port", group: "Server", label: "Port", kind: "number", env: "AGENT_DASH_PORT", help: "The dashboard listens on 127.0.0.1 at this port." },
  { key: "sessionsDir", group: "Server", label: "pi sessions folder", kind: "path", env: "AGENT_DASH_SESSIONS_DIR", help: "Where pi writes its session logs." },
  { key: "recentDays", group: "Server", label: "Recent days", kind: "number", env: "AGENT_DASH_RECENT_DAYS", help: "Runs and PRs older than this do not make groups of their own." },
  { key: "jiraServer", group: "Jira", label: "Jira server", kind: "url", env: "JIRA_SERVER", help: "For example https://your-company.atlassian.net. Empty turns Jira off." },
  { key: "jiraLogin", group: "Jira", label: "Jira login", kind: "text", env: "JIRA_LOGIN", help: "The email of your Atlassian account." },
  { key: "jiraTokenFile", group: "Jira", label: "Jira token file", kind: "path", env: "AGENT_DASH_JIRA_ENV", help: "A file with a JIRA_API_TOKEN=… line. The JIRA_API_TOKEN env var wins over it." },
  { key: "jiraExcludeProjects", group: "Jira", label: "Projects to leave out", kind: "list", pattern: PROJECT, env: "AGENT_DASH_EXCLUDE_PROJECTS", help: "Jira projects whose tickets do not show, for example a deprecated mirror." },
  { key: "ticketProjects", group: "Tickets", label: "Ticket projects", kind: "list", pattern: PROJECT, env: "AGENT_DASH_PROJECTS", help: "Key prefixes that link a run or PR to a ticket, for example ABC for ABC-123." },
  { key: "ignoreTickets", group: "Tickets", label: "Keys to ignore", kind: "list", pattern: /^[A-Z][A-Z0-9]*-\d+$/, env: "AGENT_DASH_IGNORE_TICKETS", help: "Real keys that code uses as sample data. They never link." },
  { key: "localTicketsDir", group: "Tickets", label: "Local tickets folder", kind: "path", env: "AGENT_DASH_LOCAL_TICKETS_DIR", help: "agent-dash's own AD-<n> tickets: <folder>/<status>/AD-<n>-<slug>.md. Add AD to the ticket projects too." },
  { key: "reviewChannelId", group: "Reviews", label: "Review channel id", kind: "text", pattern: /^[CG][A-Z0-9]{6,}$/, help: "The Slack channel where your team asks for PR reviews, for example C0123ABCD. Empty turns review requests off." },
  { key: "reviewChannelName", group: "Reviews", label: "Review channel name", kind: "text", pattern: /^[a-z0-9_-]+$/, help: "Its name without the #, as the page shows it." },
  { key: "noReviewRepos", group: "Reviews", label: "Repos with no review request", kind: "list", pattern: REPO, help: "owner/repo of repos that no one reviews, such as your own tools." },
  { key: "deployRepoBeta", group: "Deploys", label: "Beta deploy repo", kind: "text", pattern: REPO, help: "A merged PR in this owner/repo deploys to Beta." },
  { key: "deployRepoProd", group: "Deploys", label: "Prod deploy repo", kind: "text", pattern: REPO, help: "A merged PR in this owner/repo deploys to Prod." },
  { key: "piAuth", group: "Logins", label: "pi-auth binary", kind: "path", env: "AGENT_DASH_PI_AUTH", help: "Fix login runs `<binary> ensure jira`. Empty turns it off." },
  { key: "slackStateFile", group: "Slack", label: "Slack login state", kind: "path", help: "An agent-browser state file with a Slack login. Summary runs search Slack with it. Empty turns Slack search off." },
  { key: "slackOrgId", group: "Slack", label: "Slack org or team id", kind: "text", pattern: /^[ET][A-Z0-9]+$/, help: "An Enterprise Grid org id (E…) searches every workspace. Empty uses the first logged-in team." },
  { key: "slackWorkspaceUrl", group: "Slack", label: "Slack workspace URL", kind: "url", help: "Makes a permalink when Slack does not return one, for example https://your-company.slack.com." },
  { key: "slackReloginCommand", group: "Slack", label: "Slack sign-in command", kind: "text", help: "Shown when the Slack sign-in for posting expires." },
  { key: "environments", group: "Smoketests", label: "Environments", kind: "list", pattern: /^(localhost|postman_beta|postman_prod|fern_dev|fern_prod)$/, help: "Where a smoketest can run: localhost, postman_beta, postman_prod, fern_dev, fern_prod." },
  { key: "smoketestGuide", group: "Smoketests", label: "Local smoketest guide", kind: "path", help: "A file that a local smoketest plan reads first." },
];

/** A list setting from an env var: "A,B", "A|B" (the old regex form) or "A B". */
export const splitList = (s: string): string[] => s.split(/[\s,|]+/).filter(Boolean);

/**
 * The settings with each field checked and cleaned, plus an error per bad field.
 * Unknown keys are dropped, and a missing key takes its default.
 */
export function validateSettings(input: unknown): { settings: Settings; errors: Partial<Record<SettingKey, string>> } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const settings = { ...DEFAULT_SETTINGS } as Record<SettingKey, unknown>;
  const errors: Partial<Record<SettingKey, string>> = {};
  for (const f of SETTING_FIELDS) {
    if (!Object.hasOwn(raw, f.key)) continue;
    const v = raw[f.key];
    if (f.kind === "number") {
      const n = typeof v === "string" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65_535) errors[f.key] = "must be a whole number from 1 to 65535";
      else settings[f.key] = n;
    } else if (f.kind === "list") {
      const list = Array.isArray(v) ? v : typeof v === "string" ? splitList(v) : null;
      if (!list || !list.every((x) => typeof x === "string")) errors[f.key] = "must be a list of strings";
      else {
        const items = list.map((x: string) => x.trim()).filter(Boolean);
        const bad = f.pattern ? items.find((x) => !f.pattern!.test(x)) : undefined;
        if (bad) errors[f.key] = `"${bad}" does not look right`;
        else settings[f.key] = items;
      }
    } else if (typeof v !== "string" || v.length > 1_000 || /[\r\n]/.test(v)) {
      errors[f.key] = "must be one line of text";
    } else {
      const s = v.trim();
      if (s && f.kind === "url" && !/^https?:\/\/[^\s/]+/.test(s)) errors[f.key] = "must start with http:// or https://";
      else if (s && f.pattern && !f.pattern.test(s)) errors[f.key] = "does not look right";
      else settings[f.key] = f.kind === "url" ? s.replace(/\/+$/, "") : s;
    }
  }
  return { settings: settings as unknown as Settings, errors };
}

/** What `GET /api/settings` returns. */
export interface SettingsState {
  /** The config file, which may not exist yet. */
  file: string;
  exists: boolean;
  /** The main checkout's file, seen from a worktree server: Save is off. */
  readOnly: boolean;
  /** The file's values, with defaults for what it leaves out. */
  saved: Settings;
  /** Fields that an env var sets now, with the var's name. The file value waits until the var is gone. */
  envOverrides: Partial<Record<SettingKey, string>>;
  /** The saved values (with env overrides) differ from what the running server loaded. */
  restartNeeded: boolean;
}
