import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_SETTINGS, SETTING_FIELDS, type SettingKey, type Settings, splitList, validateSettings } from "../shared/settings.ts";
import { setTeam } from "../shared/team.ts";

const home = homedir();
const env = process.env;

/** Per-user settings live outside git, so a clone never runs with someone else's paths. */
export const CONFIG_FILE = resolve(env.AGENT_DASH_CONFIG ?? new URL("../agent-dash.config.json", import.meta.url).pathname);

export const expandHome = (p: string): string => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
const expandPath = (p: string): string => (p ? expandHome(p) : "");

/** The file's values, with defaults for what it leaves out. A bad value keeps its default. */
export function readSettingsFile(file = CONFIG_FILE): { settings: Settings; exists: boolean } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, exists: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`agent-dash: ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const { settings, errors } = validateSettings(raw);
  for (const [key, error] of Object.entries(errors)) console.warn(`agent-dash: ${file}: ${key} ${error}; using the default`);
  return { settings, exists: true };
}

/** The env vars that are set for a field now. */
export function envOverrides(e: NodeJS.ProcessEnv = env): Partial<Record<SettingKey, string>> {
  return Object.fromEntries(SETTING_FIELDS.filter((f) => f.env && e[f.env] !== undefined).map((f) => [f.key, f.env!]));
}

/** The settings that the server runs with: the file, then env vars on top. */
export function effectiveSettings(fileSettings: Settings, e: NodeJS.ProcessEnv = env): Settings {
  const out = { ...fileSettings } as Record<SettingKey, unknown>;
  for (const f of SETTING_FIELDS) {
    const v = f.env ? e[f.env] : undefined;
    if (v === undefined) continue;
    out[f.key] = f.kind === "number" ? Number(v) : f.kind === "list" ? splitList(v) : v;
  }
  return out as unknown as Settings;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Ticket keys of the given projects, minus the ignored keys. No projects match nothing. */
export function ticketPatternOf(projects: string[], ignore: string[]): RegExp {
  if (!projects.length) return /(?!)/g;
  const skip = ignore.length ? `(?!(?:${ignore.map(escape).join("|")})\\b)` : "";
  return new RegExp(`\\b${skip}(?:${projects.map(escape).join("|")})-\\d+\\b`, "g");
}

export function buildConfig(s: Settings) {
  return {
    settings: s,
    port: s.port,
    sessionsDir: expandPath(s.sessionsDir),
    /** The pi extension writes one status file per session here. */
    statusDir: env.AGENT_DASH_STATUS_DIR ?? join(home, ".agent-dash/status"),
    /** Replies typed in the dash go here, one folder per session; the extension delivers them. */
    inboxDir: env.AGENT_DASH_INBOX_DIR ?? join(home, ".agent-dash/inbox"),
    /** Context files for agents started from the dash, kept so you can see what each one got. */
    handoffDir: join(home, ".agent-dash/handoffs"),
    /** stdin FIFO and output log of each headless conversation started from the dash. */
    conversationsDir: env.AGENT_DASH_CONVERSATIONS_DIR ?? join(home, ".agent-dash/conversations"),
    jira: {
      server: s.jiraServer,
      login: s.jiraLogin,
      tokenFile: expandPath(s.jiraTokenFile),
      excludeProjects: s.jiraExcludeProjects,
    },
    /** agent-dash's own tickets (`AD-<n>`): markdown files in one folder per status, not Jira issues. */
    localTicketsDir: expandPath(s.localTicketsDir),
    /** Ticket keys that a run can link to. */
    ticketPattern: ticketPatternOf(s.ticketProjects, s.ignoreTickets),
    piAuth: expandPath(s.piAuth),
    slack: {
      stateFile: expandPath(s.slackStateFile),
      orgId: s.slackOrgId,
      workspaceUrl: s.slackWorkspaceUrl,
      reloginCommand: s.slackReloginCommand,
    },
    smoketestGuide: expandPath(s.smoketestGuide),
    /** Runs and PRs older than this do not create "other ticket" groups or unlinked rows. */
    recentDays: s.recentDays,
    /** Jira and GitHub answers are cached this long, so a page refresh does not hit the APIs. */
    remoteTtlMs: Number(env.AGENT_DASH_REMOTE_TTL_MS ?? 120_000),
  };
}

export const config = buildConfig(effectiveSettings(readSettingsFile().settings));
setTeam(config.settings);

/** Jira is asked only with a server and a login; without them it is off, not down. */
export const jiraConfigured = (c: Pick<ReturnType<typeof buildConfig>, "jira"> = config): boolean => !!(c.jira.server && c.jira.login);

/** What a new user still has to set before the board works, in words for the setup banner. */
export function setupNeeded(c: Pick<ReturnType<typeof buildConfig>, "jira" | "settings"> = config, e: NodeJS.ProcessEnv = env): string[] {
  const out: string[] = [];
  if (!c.jira.server) out.push("the Jira server");
  else {
    if (!c.jira.login) out.push("your Jira login");
    if (!c.jira.tokenFile && !e.JIRA_API_TOKEN) out.push("a Jira token file");
  }
  if (!c.settings.ticketProjects.length) out.push("your ticket projects");
  if (!c.settings.userName) out.push("your first name");
  return out;
}
