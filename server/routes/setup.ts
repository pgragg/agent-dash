import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_SETTINGS, SETTING_FIELDS, type Settings } from "../../shared/settings.ts";
import { AGENT_LABEL, type AgentKind } from "../../shared/team.ts";
import { installPiExtension, piExtensionFile } from "../agent.ts";
import { CONFIG_FILE, CONFIG_READ_ONLY, config, readSettingsFile, saveSettingsPatch, sessionsDirOf, setupNeeded } from "../config.ts";
import { startConversation } from "../conversations.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const SAVE_SCRIPT = `${ROOT}/scripts/save-settings.ts`;

/** Claude Code reads and searches without a dialog; a Bash or a Write still asks on the page. */
const CLAUDE_READ_TOOLS = ["Read", "Grep", "Glob", "LS"];

const shown = (v: Settings[keyof Settings]): string => {
  const s = Array.isArray(v) ? v.join(", ") : String(v);
  return s ? `\`${s}\`` : "not set";
};

/**
 * The setup agent's first message. Each setting brings its description, example and where to
 * find it, so the agent needs nothing more than this message and the script.
 */
export function setupMessage(o: { agent: AgentKind; file: string; current: Settings; missing: string[]; script: string; url: string }): string {
  const settings = SETTING_FIELDS.filter((f) => f.key !== "agent").map((f) => {
    const dflt = JSON.stringify(o.current[f.key]) === JSON.stringify(DEFAULT_SETTINGS[f.key]) ? " (the default)" : "";
    return `- \`${f.key}\` (${f.label}${f.kind === "list" ? ", a list" : ""}): ${f.help} Example: \`${f.example}\`. How to find it: ${f.find} Now: ${shown(o.current[f.key])}${dflt}.`;
  });
  return `Set up agent-dash for the user: find the value of each setting below on this machine, and save them.

agent-dash is a local dashboard at ${o.url} (its code is in this folder, and README.md explains it). Its settings live in ${o.file}. The user clicked "Set it up for me" on the page and picked ${AGENT_LABEL[o.agent]} as the agent. That click is their permission for this job.

Rules:
- Look, do not change. Read files and run read-only commands (\`git config\`, \`gh\`, \`ls\`, \`grep\`, \`find\`, a GET with \`curl\`). The only file that you write is the settings file, through the script below.
- Never print a secret. Find a Jira token file by the name of its key (\`grep -l\`, \`grep -c\`), and never show its contents.
- Use each setting's "How to find it". When it says to keep the default, or you find nothing better, keep the value that it has now.
- Do not guess. When you cannot check a value, leave it and ask the user. Ask in your reply, not with a question tool: the page cannot show one.
- Do not change \`agent\`: the user picked it.

Steps:
1. Read the current file: \`cat ${o.file}\` (it may not exist yet).
2. Find a value for each setting below.${o.missing.length ? ` Start with what is still missing: ${o.missing.join(", ")}.` : ""}
3. Save every value that you found at once. Write a JSON object with only the keys to change to a temp file, then run \`node ${o.script} < that-file.json\`. A list is a JSON array. The script checks each value as the Settings page does, keeps the keys that you leave out, and saves nothing when one value is wrong. Fix what it names and run it again.
4. With a Jira login and token file, check them, and print only the HTTP status: \`(set -a; . <token file>; curl -s -o /dev/null -w '%{http_code}\\n' -u "<login>:$JIRA_API_TOKEN" <server>/rest/api/3/myself)\`. 200 means that they work.
5. Reply with a short table: setting, new value, and where you found it. Then list each setting that you could not find, with one question to the user for each. When the user answers, save again.
6. At the end, tell the user to restart agent-dash, then to check the values on the Settings page: ${o.url}/#/settings.

Settings:
${settings.join("\n")}`;
}

export interface SetupDeps {
  /** Show a session from another agent's log folder on the board, before a restart. */
  follow: (dir: string, sessionId: string) => void;
}

/**
 * `POST /api/setup` with `{agent}`: save the agent, then start a headless setup agent with it.
 * The click on the banner's Start is the user's permission.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, deps: SetupDeps): Promise<boolean> {
  if (url.pathname !== "/api/setup" || req.method !== "POST") return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    return true;
  };
  // It starts an agent that runs commands, so the same CSRF guard as the other writes.
  if (req.headers["x-agent-dash"] !== "1") return json(403, { error: "missing X-Agent-Dash header" });
  if (CONFIG_READ_ONLY) return json(409, { error: `this server reads ${CONFIG_FILE} from the main checkout; set it up from the main checkout's server` });
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4_000) return json(413, { error: "request body too large" });
  }
  let agent: unknown;
  try {
    agent = (JSON.parse(body || "{}") as { agent?: unknown }).agent;
  } catch {
    return json(400, { error: "the body is not JSON" });
  }
  if (agent !== "pi" && agent !== "claude") return json(400, { error: "agent must be pi or claude" });
  try {
    // A headless pi gets its first message through the status extension. Any copy of it works.
    if (agent === "pi" && !existsSync(piExtensionFile())) installPiExtension();
    // Saved first, so the choice stays when the agent stops early. The board uses it after a restart.
    const { settings, errors } = saveSettingsPatch({ agent });
    if (Object.keys(errors).length) return json(500, { error: `could not save the agent: ${Object.values(errors).join("; ")}` });
    const sessionId = randomUUID();
    deps.follow(sessionsDirOf(settings, agent), sessionId);
    const message = setupMessage({ agent, file: CONFIG_FILE, current: readSettingsFile().settings, missing: setupNeeded(), script: SAVE_SCRIPT, url: `http://127.0.0.1:${config.port}` });
    startConversation({ cwd: ROOT, message, name: "agent-dash setup", sessionId, agent, allowedTools: agent === "claude" ? CLAUDE_READ_TOOLS : undefined });
    return json(201, { sessionId });
  } catch (err) {
    return json(500, { error: (err as Error).message });
  }
}
