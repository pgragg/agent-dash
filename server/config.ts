import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_SETTINGS, SETTING_FIELDS, type SettingKey, type Settings, splitList, type TicketProviderSettings, validateSettings } from "../shared/settings.ts";
import { setTeam } from "../shared/team.ts";

const home = homedir();
const env = process.env;

const NAME = "agent-dash.config.json";

/** The main checkout of a git worktree, from its `.git` file; null in a main checkout or outside git. */
export function mainCheckoutOf(root: string): string | null {
  try {
    // In a worktree `.git` is a file; in a main checkout it is a folder, and the read throws.
    const gitdir = resolve(root, /^gitdir: (.+)$/m.exec(readFileSync(join(root, ".git"), "utf8"))![1].trim());
    return dirname(resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim()));
  } catch {
    return null;
  }
}

/**
 * The repo's own file, else the main checkout's, so a test server in a worktree runs with the
 * owner's settings. The main checkout's file is read-only from there: a test server must not change it.
 */
export function findConfigFile(root: string, explicit = env.AGENT_DASH_CONFIG): { file: string; readOnly: boolean } {
  if (explicit) return { file: resolve(explicit), readOnly: false };
  const own = join(root, NAME);
  const main = existsSync(own) ? null : mainCheckoutOf(root);
  return main && existsSync(join(main, NAME)) ? { file: join(main, NAME), readOnly: true } : { file: own, readOnly: false };
}

/** Per-user settings live outside git, so a clone never runs with someone else's paths. */
export const { file: CONFIG_FILE, readOnly: CONFIG_READ_ONLY } = findConfigFile(new URL("..", import.meta.url).pathname);

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

/** Write the whole settings object. A rename is atomic, so a crash never leaves half a file that stops the next start. */
export function writeSettingsFile(settings: Settings, file = CONFIG_FILE): void {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * Change some keys and keep the others, with the Settings page's checks. Nothing is written
 * when one value is bad, so the setup agent can fix its values and try again.
 */
export function saveSettingsPatch(patch: Record<string, unknown>, file = CONFIG_FILE): { settings: Settings; errors: Partial<Record<SettingKey, string>> } {
  const unknown = Object.keys(patch).filter((k) => !SETTING_FIELDS.some((f) => f.key === k));
  const out = validateSettings({ ...readSettingsFile(file).settings, ...patch });
  for (const k of unknown) (out.errors as Record<string, string>)[k] = "is not a setting";
  if (!Object.keys(out.errors).length) writeSettingsFile(out.settings, file);
  return out;
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
    if (f.kind === "choice" && !f.options!.some((o) => o.value === v)) {
      console.warn(`agent-dash: ${f.env}=${v} is not one of ${f.options!.map((o) => o.value).join(", ")}; ignoring it`);
      continue;
    }
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

/** A provider's settings with its id set and its paths expanded. */
export type TicketProviderConfig = TicketProviderSettings & { id: string };

/**
 * The ticket trackers, in order. The file's `ticketProviders` list wins; without one, the flat Jira
 * fields make a Jira provider and the local tickets folder makes an AD provider, as before the list.
 */
export function ticketProvidersOf(s: Settings): TicketProviderConfig[] {
  const list: TicketProviderSettings[] = s.ticketProviders.length
    ? s.ticketProviders
    : [
        ...(s.jiraServer ? [{ type: "jira" as const, server: s.jiraServer, login: s.jiraLogin, tokenFile: s.jiraTokenFile, excludeProjects: s.jiraExcludeProjects, projects: [] }] : []),
        ...(s.localTicketsDir ? [{ type: "local" as const, prefix: "AD", dir: s.localTicketsDir }] : []),
      ];
  return list.map((p) =>
    p.type === "jira"
      ? { ...p, id: p.id ?? "jira", tokenFile: expandPath(p.tokenFile) }
      : { ...p, id: p.id ?? `local-${p.prefix}`, dir: expandPath(p.dir) },
  );
}

/** The ticket projects, plus each provider's own prefixes, so a local folder needs no second setting. */
export function ticketProjectsOf(s: Settings, providers: TicketProviderConfig[]): string[] {
  const own = providers.flatMap((p) => (p.type === "local" ? [p.prefix] : p.projects));
  return [...new Set([...s.ticketProjects, ...own])];
}

/**
 * OpenCode keeps its sessions in SQLite, not in log files. The dash copies each one here as a pi
 * log, so every reader of a session file works the same for it.
 */
export const opencodeLogDir = (): string => env.AGENT_DASH_OPENCODE_LOG_DIR ?? join(home, ".agent-dash/opencode-sessions");

/** The folder of an agent's session logs. */
export const sessionsDirOf = (s: Settings, agent: Settings["agent"]): string => (agent === "opencode" ? opencodeLogDir() : expandPath(agent === "claude" ? s.claudeProjectsDir : s.sessionsDir));

export function buildConfig(s: Settings) {
  const providers = ticketProvidersOf(s);
  return {
    settings: s,
    port: s.port,
    agent: s.agent,
    /** The session logs of the agent that the board shows. */
    sessionsDir: sessionsDirOf(s, s.agent),
    /** OpenCode's own database, which the dash reads only. */
    opencodeDb: expandPath(s.opencodeDb),
    /** The pi extension and the Claude Code hook write one status file per session here. */
    statusDir: env.AGENT_DASH_STATUS_DIR ?? join(home, ".agent-dash/status"),
    /** Replies typed in the dash go here, one folder per session; the extension delivers them. */
    inboxDir: env.AGENT_DASH_INBOX_DIR ?? join(home, ".agent-dash/inbox"),
    /** The last answers of GitHub and the remote trackers, so the first build after a restart is fast. */
    cacheDir: env.AGENT_DASH_CACHE_DIR ?? join(home, ".agent-dash/cache"),
    /** Context files for agents started from the dash, kept so you can see what each one got. */
    handoffDir: join(home, ".agent-dash/handoffs"),
    /** stdin FIFO and output log of each headless conversation started from the dash. */
    conversationsDir: env.AGENT_DASH_CONVERSATIONS_DIR ?? join(home, ".agent-dash/conversations"),
    /** The ticket trackers that the board reads, in order. `server/tickets/registry.ts` makes a provider of each. */
    ticketProviders: providers,
    /** Ticket keys that a run can link to. */
    ticketPattern: ticketPatternOf(ticketProjectsOf(s, providers), s.ignoreTickets),
    piAuth: expandPath(s.piAuth),
    slack: {
      stateFile: expandPath(s.slackStateFile),
      orgId: s.slackOrgId,
      workspaceUrl: s.slackWorkspaceUrl,
      reloginCommand: s.slackReloginCommand,
    },
    smoketestGuide: expandPath(s.smoketestGuide),
    /** The local Obsidian vault of the Wiki view; empty turns it off. */
    wikiDir: expandPath(s.wikiDir),
    /** Runs and PRs older than this do not create "other ticket" groups or unlinked rows. */
    recentDays: s.recentDays,
    /** Remote tracker and GitHub answers are cached this long, so a page refresh does not hit the APIs. */
    remoteTtlMs: Number(env.AGENT_DASH_REMOTE_TTL_MS ?? 120_000),
  };
}

export const config = buildConfig(effectiveSettings(readSettingsFile().settings));
setTeam(config.settings);

/** What a new user still has to set before the board works, in words for the setup banner. */
export function setupNeeded(c: Pick<ReturnType<typeof buildConfig>, "ticketProviders" | "settings"> = config, e: NodeJS.ProcessEnv = env): string[] {
  const out: string[] = [];
  if (!c.ticketProviders.length) out.push("the Jira server");
  for (const p of c.ticketProviders) {
    if (p.type !== "jira") continue;
    if (!p.login) out.push("your Jira login");
    if (!p.tokenFile && !e.JIRA_API_TOKEN) out.push("a Jira token file");
  }
  if (!ticketProjectsOf(c.settings, c.ticketProviders).length) out.push("your ticket projects");
  if (!c.settings.userName) out.push("your first name");
  return [...new Set(out)];
}
