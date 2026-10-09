import { AGENT_LABEL, DEFAULT_TEAM, type Team } from "./team.ts";

/**
 * The per-user settings in `agent-dash.config.json`. One list of fields drives the server's
 * defaults, env overrides and validation, and the Settings page's form. Free of Node and React.
 */

/**
 * One ticket tracker in `ticketProviders`. `id` names it in the source health and must be unique;
 * it defaults to the type (`jira`) or `local-<prefix>`.
 */
export type TicketProviderSettings =
  | {
      type: "jira";
      id?: string;
      server: string;
      login: string;
      /** A file with a JIRA_API_TOKEN=… line. The JIRA_API_TOKEN env var wins over it. */
      tokenFile: string;
      excludeProjects: string[];
      /** Key prefixes in this Jira. Empty: every key that no other provider claims. */
      projects: string[];
    }
  | {
      type: "local";
      id?: string;
      /** The key prefix, such as AD for AD-12. */
      prefix: string;
      /** The folder above the status folders: <dir>/<status>/<PREFIX>-<n>-<slug>.md. */
      dir: string;
    };

export interface Settings extends Team {
  port: number;
  sessionsDir: string;
  claudeProjectsDir: string;
  /** The `--permission-mode` of the Claude Code runs that the dash starts. */
  claudePermissionMode: "auto" | "acceptEdits" | "default";
  opencodeDb: string;
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
  /** The local Obsidian vault that the Wiki view reads. Empty turns the view off. */
  wikiDir: string;
  /**
   * The ticket trackers, in order. Empty: the flat Jira fields and the local tickets folder make
   * them. The Settings page does not edit this list yet; the file does.
   */
  ticketProviders: TicketProviderSettings[];
}

export type SettingKey = keyof Settings;

export interface SettingField {
  key: SettingKey;
  group: "Agent" | "You" | "Server" | "Jira" | "Tickets" | "Reviews" | "Deploys" | "Logins" | "Slack" | "Smoketests" | "Wiki";
  label: string;
  kind: "number" | "text" | "path" | "url" | "list" | "choice";
  /** The values of a choice, with their labels. */
  options?: { value: string; label: string }[];
  /** A list value must match this; a text value too, when it is not empty. */
  pattern?: RegExp;
  /** An env var that wins over the file, for a test server or a one-off run. */
  env?: string;
  /** What the setting does, in one or two sentences. */
  help: string;
  /** A value that looks right, as the Settings page and the setup agent show it. */
  example: string;
  /** Where to find the value: a command to run or a place to look. The setup agent follows it. */
  find: string;
}

/**
 * Company-wide values are defaults, so a colleague sets only their own: the Jira login and token,
 * ticket projects, and the paths on their machine.
 */
export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_TEAM,
  port: 7777,
  sessionsDir: "~/.pi/agent/sessions",
  claudeProjectsDir: "~/.claude/projects",
  claudePermissionMode: "auto",
  opencodeDb: "~/.local/share/opencode/opencode.db",
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
  wikiDir: "",
  ticketProviders: [],
};

const PROJECT = /^[A-Z][A-Z0-9]*$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export const SETTING_FIELDS: SettingField[] = [
  {
    key: "agent", group: "Agent", label: "Agent", kind: "choice", options: Object.entries(AGENT_LABEL).map(([value, label]) => ({ value, label })), env: "AGENT_DASH_AGENT",
    help: "The coding agent that agent-dash starts for runs, summaries and drafts, and whose session logs the board shows.",
    example: "pi",
    find: "The agent you use for your coding sessions. `pi --version`, `claude --version` and `opencode --version` show which ones are installed.",
  },
  {
    key: "claudePermissionMode", group: "Agent", label: "Claude Code permissions", kind: "choice", env: "AGENT_DASH_CLAUDE_PERMISSION_MODE",
    options: [
      { value: "auto", label: "Auto: a classifier approves safe tool calls" },
      { value: "acceptEdits", label: "Accept edits: ask before commands only" },
      { value: "default", label: "Ask before each tool call" },
    ],
    help: "When a Claude Code run on the page asks before a tool call. Used when the agent is Claude Code; a run in iTerm uses your own Claude Code settings.",
    example: "auto",
    find: "Keep auto. Pick acceptEdits when `claude --permission-mode auto` says that auto mode is not available.",
  },
  {
    key: "userName", group: "You", label: "Your first name", kind: "text", pattern: /^[^\s"'`]{1,40}$/,
    help: "Agents call you by this name in the prompts that agent-dash writes. Empty: \"the user\".",
    example: "Sam",
    find: "The first word of `git config --global user.name`, or of `id -F`.",
  },
  {
    key: "port", group: "Server", label: "Port", kind: "number", env: "AGENT_DASH_PORT",
    help: "The dashboard listens on 127.0.0.1 at this port.",
    example: "7777",
    find: "Keep 7777. Change it only when a program that is not agent-dash listens there: `lsof -iTCP:7777 -sTCP:LISTEN`.",
  },
  {
    key: "sessionsDir", group: "Server", label: "pi sessions folder", kind: "path", env: "AGENT_DASH_SESSIONS_DIR",
    help: "Where pi writes its session logs. Used when the agent is pi.",
    example: "~/.pi/agent/sessions",
    find: "Keep the default. `ls ~/.pi/agent/sessions` shows one folder per project when pi is installed.",
  },
  {
    key: "claudeProjectsDir", group: "Server", label: "Claude Code projects folder", kind: "path", env: "AGENT_DASH_CLAUDE_PROJECTS_DIR",
    help: "Where Claude Code writes its session logs. Used when the agent is Claude Code.",
    example: "~/.claude/projects",
    find: "Keep the default, unless `CLAUDE_CONFIG_DIR` is set: then it is `$CLAUDE_CONFIG_DIR/projects`. `ls ~/.claude/projects` shows one folder per project.",
  },
  {
    key: "opencodeDb", group: "Server", label: "OpenCode database", kind: "path", env: "AGENT_DASH_OPENCODE_DB",
    help: "The SQLite file where OpenCode 2 keeps its sessions. Used when the agent is OpenCode.",
    example: "~/.local/share/opencode/opencode.db",
    find: "Keep the default, unless `XDG_DATA_HOME` is set: then it is `$XDG_DATA_HOME/opencode/opencode.db`. `ls ~/.local/share/opencode` shows it when OpenCode is installed.",
  },
  {
    key: "recentDays", group: "Server", label: "Recent days", kind: "number", env: "AGENT_DASH_RECENT_DAYS",
    help: "Runs and PRs older than this do not make groups of their own.",
    example: "14",
    find: "Keep 14. A smaller number gives a shorter board.",
  },
  {
    key: "jiraServer", group: "Jira", label: "Jira server", kind: "url", env: "JIRA_SERVER",
    help: "The Jira site that holds your tickets. Empty turns Jira off.",
    example: "https://postmanlabs.atlassian.net",
    find: "The start of a Jira ticket link, up to `.net`. With jira-cli, the `server:` line of `~/.config/.jira/.config.yml`.",
  },
  {
    key: "jiraLogin", group: "Jira", label: "Jira login", kind: "text", env: "JIRA_LOGIN",
    help: "The email of your Atlassian account.",
    example: "sam@postman.com",
    find: "Your work email: `git config --global user.email`, or the `login:` line of `~/.config/.jira/.config.yml`.",
  },
  {
    key: "jiraTokenFile", group: "Jira", label: "Jira token file", kind: "path", env: "AGENT_DASH_JIRA_ENV",
    help: "A file with a JIRA_API_TOKEN=… line. The JIRA_API_TOKEN env var wins over it.",
    example: "~/.config/agent-dash/jira.env",
    find: "Look for a file that has the line, without printing the token: `grep -rls '^JIRA_API_TOKEN=' ~/.config ~/.env* ~/pi/secrets 2>/dev/null`. With none, make a token at https://id.atlassian.com/manage-profile/security/api-tokens, copy it, and run `mkdir -p ~/.config/agent-dash && (umask 077; printf 'JIRA_API_TOKEN=%s\\n' \"$(pbpaste)\" > ~/.config/agent-dash/jira.env)`.",
  },
  {
    key: "jiraExcludeProjects", group: "Jira", label: "Projects to leave out", kind: "list", pattern: PROJECT, env: "AGENT_DASH_EXCLUDE_PROJECTS",
    help: "Jira projects whose tickets do not show, for example a deprecated mirror.",
    example: "FSM",
    find: "Usually empty. Add a project whose open tickets are copies of tickets in another project, such as FSM (mirrored into FSDK).",
  },
  {
    key: "ticketProjects", group: "Tickets", label: "Ticket projects", kind: "list", pattern: PROJECT, env: "AGENT_DASH_PROJECTS",
    help: "Key prefixes that link a run or PR to a ticket, for example ABC for ABC-123.",
    example: "FSDK, EFSUP",
    find: "The prefixes of the open Jira tickets assigned to you: `jira issue list -a\"$(jira me)\" --plain --no-headers --columns key`, or a GET of `<Jira server>/rest/api/3/search/jql?jql=assignee=currentUser()+AND+statusCategory!=Done&fields=key` with the login and token. Also the keys in your branch names: `gh search prs --author @me --limit 50 --json title`.",
  },
  {
    key: "ignoreTickets", group: "Tickets", label: "Keys to ignore", kind: "list", pattern: /^[A-Z][A-Z0-9]*-\d+$/, env: "AGENT_DASH_IGNORE_TICKETS",
    help: "Real keys that code uses as sample data. They never link.",
    example: "FSDK-1",
    find: "Usually empty. Add a key that shows up in many unrelated runs because code or docs use it as an example.",
  },
  {
    key: "localTicketsDir", group: "Tickets", label: "Local tickets folder", kind: "path", env: "AGENT_DASH_LOCAL_TICKETS_DIR",
    help: "agent-dash's own AD-<n> tickets: <folder>/<status>/AD-<n>-<slug>.md. AD keys link without a ticket project. For other prefixes or folders, use a ticketProviders list in the file.",
    example: "~/pi/projects/27_agent_dash/project_management",
    find: "Usually empty: only for people who work on agent-dash itself. It is the folder above the status folders of the AD-*.md files: `mdfind -onlyin ~ 'kMDItemFSName == \"AD-*.md\"' | grep -E '/(todo|in-progress|in-review|done|canceled)/AD-' | head -3`.",
  },
  {
    key: "reviewChannelId", group: "Reviews", label: "Review channel id", kind: "text", pattern: /^[CG][A-Z0-9]{6,}$/,
    help: "The Slack channel where your team asks for PR reviews. Empty turns review requests off.",
    example: "C0123ABCD",
    find: "Ask the user which channel their team uses for review requests. In Slack, click the channel name: the id is at the bottom of the About tab.",
  },
  {
    key: "reviewChannelName", group: "Reviews", label: "Review channel name", kind: "text", pattern: /^[a-z0-9_-]+$/,
    help: "Its name without the #, as the page shows it.",
    example: "my-team-reviews",
    find: "The name of the review channel, as Slack shows it, without the #.",
  },
  {
    key: "noReviewRepos", group: "Reviews", label: "Repos with no review request", kind: "list", pattern: REPO,
    help: "owner/repo of repos that no one reviews, such as your own tools.",
    example: "sam/dotfiles",
    find: "Your personal repos that you open PRs in: `gh repo list --limit 30 --json nameWithOwner -q '.[].nameWithOwner'`. Ask the user before you add one.",
  },
  {
    key: "deployRepoBeta", group: "Deploys", label: "Beta deploy repo", kind: "text", pattern: REPO,
    help: "A merged PR in this owner/repo deploys to Beta.",
    example: "postman-eng/cloud9-parcels-deployments",
    find: "Keep the default for Postman services. Elsewhere, ask the user's team where Beta deploy PRs go.",
  },
  {
    key: "deployRepoProd", group: "Deploys", label: "Prod deploy repo", kind: "text", pattern: REPO,
    help: "A merged PR in this owner/repo deploys to Prod.",
    example: "postman-eng/cloud9-parcels-production-deployments",
    find: "Keep the default for Postman services. Elsewhere, ask the user's team where Prod deploy PRs go.",
  },
  {
    key: "piAuth", group: "Logins", label: "pi-auth binary", kind: "path", env: "AGENT_DASH_PI_AUTH",
    help: "Fix login runs `<binary> ensure jira`. Empty turns it off.",
    example: "~/pi/auth/pi-auth",
    find: "Usually empty. `command -v pi-auth || ls ~/pi/auth/pi-auth` finds it when it is installed.",
  },
  {
    key: "slackStateFile", group: "Slack", label: "Slack login state", kind: "path",
    help: "An agent-browser state file with a Slack login. Summary runs search Slack with it. Empty turns Slack search off.",
    example: "~/.config/agent-dash/slack-state.json",
    find: "A file that `agent-browser state save` wrote after a Slack login: `mdfind -onlyin ~ -name state | grep -i slack | grep '\\.json$'`. Empty when agent-browser is not set up.",
  },
  {
    key: "slackOrgId", group: "Slack", label: "Slack org or team id", kind: "text", pattern: /^[ET][A-Z0-9]+$/,
    help: "An Enterprise Grid org id (E…) searches every workspace. Empty uses the first logged-in team.",
    example: "E071JP7HM0C",
    find: "Keep the default at Postman. Elsewhere, the E… or T… part of the address when Slack is open in a browser: `https://app.slack.com/client/<id>/…`.",
  },
  {
    key: "slackWorkspaceUrl", group: "Slack", label: "Slack workspace URL", kind: "url",
    help: "Makes a permalink when Slack does not return one.",
    example: "https://postman.enterprise.slack.com",
    find: "Keep the default at Postman. Elsewhere, the address of Slack in a browser, up to `.com`.",
  },
  {
    key: "slackReloginCommand", group: "Slack", label: "Slack sign-in command", kind: "text",
    help: "Shown when the Slack sign-in for posting expires.",
    example: "node ~/pi/slack/bin/mcp-slack-login.mjs --force",
    find: "Usually empty. The command that signs the pi-mcp-adapter `slack` server in again, if the user has one.",
  },
  {
    key: "environments", group: "Smoketests", label: "Environments", kind: "list", pattern: /^(localhost|postman_beta|postman_prod|fern_dev|fern_prod)$/,
    help: "Where a smoketest can run: localhost, postman_beta, postman_prod, fern_dev, fern_prod.",
    example: "localhost, postman_beta, postman_prod",
    find: "Keep the default for Postman services. Add fern_dev and fern_prod for work on Fern's own stack.",
  },
  {
    key: "smoketestGuide", group: "Smoketests", label: "Local smoketest guide", kind: "path",
    help: "A file that a local smoketest plan reads first.",
    example: "~/notes/local-smoketesting.md",
    find: "Usually empty. A markdown file that tells how to run your services locally, if the user keeps one.",
  },
  {
    key: "wikiDir", group: "Wiki", label: "Wiki folder", kind: "path", env: "AGENT_DASH_WIKI_DIR",
    help: "A local Obsidian vault (a folder of markdown notes). The Wiki view lists, searches and shows its notes, read-only. Empty hides the view.",
    example: "~/pi/wiki",
    find: "Ask the user if they keep an Obsidian vault. The vault is the folder that holds a `.obsidian` folder: `mdfind -onlyin ~ 'kMDItemFSName == \".obsidian\"' | head -5`, then take the parent folder.",
  },
];

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const text = (v: unknown): v is string => typeof v === "string" && v.length <= 1_000 && !/[\r\n]/.test(v);

/** The `ticketProviders` list, checked, or an error for the first bad entry. */
export function validateTicketProviders(v: unknown): { value: TicketProviderSettings[] } | { error: string } {
  if (!Array.isArray(v)) return { error: "must be a list of ticket providers" };
  const out: TicketProviderSettings[] = [];
  for (const [i, raw] of v.entries()) {
    const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = p.id === undefined ? undefined : text(p.id) && /^[\w-]+$/.test(p.id) ? p.id : null;
    if (id === null) return { error: `entry ${i + 1}: id must be letters, digits, - or _` };
    if (p.type === "jira") {
      const server = p.server ?? "";
      if (!text(server) || (server && !/^https?:\/\/[^\s/]+/.test(server))) return { error: `entry ${i + 1}: server must start with http:// or https://` };
      for (const k of ["login", "tokenFile"]) if (p[k] !== undefined && !text(p[k])) return { error: `entry ${i + 1}: ${k} must be one line of text` };
      for (const k of ["excludeProjects", "projects"]) {
        if (p[k] !== undefined && !(strings(p[k]) && p[k].every((x) => PROJECT.test(x)))) return { error: `entry ${i + 1}: ${k} must be a list of project keys` };
      }
      out.push({
        type: "jira",
        ...(id ? { id } : {}),
        server: server.trim().replace(/\/+$/, ""),
        login: ((p.login as string) ?? "").trim(),
        tokenFile: ((p.tokenFile as string) ?? "").trim(),
        excludeProjects: (p.excludeProjects as string[]) ?? [],
        projects: (p.projects as string[]) ?? [],
      });
    } else if (p.type === "local") {
      if (!text(p.prefix) || !PROJECT.test(p.prefix)) return { error: `entry ${i + 1}: prefix must be a project key, such as AD` };
      if (!text(p.dir) || !p.dir.trim()) return { error: `entry ${i + 1}: dir must be a folder` };
      out.push({ type: "local", ...(id ? { id } : {}), prefix: p.prefix, dir: p.dir.trim() });
    } else return { error: `entry ${i + 1}: type must be jira or local` };
  }
  return { value: out };
}

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
    } else if (f.kind === "choice") {
      if (!f.options!.some((o) => o.value === v)) errors[f.key] = `must be one of ${f.options!.map((o) => o.value).join(", ")}`;
      else settings[f.key] = v;
    } else if (typeof v !== "string" || v.length > 1_000 || /[\r\n]/.test(v)) {
      errors[f.key] = "must be one line of text";
    } else {
      const s = v.trim();
      if (s && f.kind === "url" && !/^https?:\/\/[^\s/]+/.test(s)) errors[f.key] = "must start with http:// or https://";
      else if (s && f.pattern && !f.pattern.test(s)) errors[f.key] = "does not look right";
      else settings[f.key] = f.kind === "url" ? s.replace(/\/+$/, "") : s;
    }
  }
  // Not a field of the form: a list of objects, which the file holds.
  if (Object.hasOwn(raw, "ticketProviders")) {
    const r = validateTicketProviders(raw.ticketProviders);
    if ("error" in r) errors.ticketProviders = r.error;
    else settings.ticketProviders = r.value;
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
