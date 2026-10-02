import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const env = process.env;

export const config = {
  port: Number(env.AGENT_DASH_PORT ?? 7777),
  sessionsDir: env.AGENT_DASH_SESSIONS_DIR ?? join(home, ".pi/agent/sessions"),
  /** The pi extension writes one status file per session here. */
  statusDir: env.AGENT_DASH_STATUS_DIR ?? join(home, ".agent-dash/status"),
  /** Replies typed in the dash go here, one folder per session; the extension delivers them. */
  inboxDir: env.AGENT_DASH_INBOX_DIR ?? join(home, ".agent-dash/inbox"),
  /** Context files for agents started from the dash, kept so you can see what each one got. */
  handoffDir: join(home, ".agent-dash/handoffs"),
  /** stdin FIFO and output log of each headless conversation started from the dash. */
  conversationsDir: env.AGENT_DASH_CONVERSATIONS_DIR ?? join(home, ".agent-dash/conversations"),
  jira: {
    server: env.JIRA_SERVER ?? "https://postmanlabs.atlassian.net",
    login: env.JIRA_LOGIN ?? "piper.gragg@postman.com",
    tokenFile: env.AGENT_DASH_JIRA_ENV ?? join(home, "pi/secrets/jira/.env.personal"),
    /** FSM is deprecated and mirrored into FSDK, so its tickets would show twice. */
    excludeProjects: (env.AGENT_DASH_EXCLUDE_PROJECTS ?? "FSM").split(",").filter(Boolean),
  },
  /** Ticket keys that a run can link to. */
  ticketPattern: new RegExp(`\\b(?:${env.AGENT_DASH_PROJECTS ?? "FSDK|EFSUP"})-\\d+\\b`, "g"),
  /** Runs and PRs older than this do not create "other ticket" groups or unlinked rows. */
  recentDays: Number(env.AGENT_DASH_RECENT_DAYS ?? 14),
  /** Jira and GitHub answers are cached this long, so a page refresh does not hit the APIs. */
  remoteTtlMs: Number(env.AGENT_DASH_REMOTE_TTL_MS ?? 120_000),
};
