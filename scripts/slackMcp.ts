/**
 * Connects to Slack's hosted MCP with the pi-mcp-adapter `slack` sign-in, an OAuth grant.
 * Slack search and Post to Slack both use it, because copied Slack cookies get the session revoked.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { config as dash } from "../server/config.ts";

const ADAPTER = process.env.AGENT_DASH_MCP_ADAPTER ?? join(homedir(), ".pi/agent/npm/node_modules/pi-mcp-adapter/dist");
const SERVER = "slack";
export const RELOGIN = dash.slack.reloginCommand ? `Run \`${dash.slack.reloginCommand}\` and allow the grant in the browser.` : "Sign in to the slack MCP server of pi-mcp-adapter again.";

type Tool = { name: string; inputSchema?: { properties?: Record<string, unknown> } };
type Result = { content?: { text?: string }[]; isError?: boolean };
export type SlackClient = {
  listTools(): Promise<{ tools: Tool[] }>;
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<Result>;
};

/**
 * `off` when the adapter or its slack server is not set up, `error` when the sign-in fails.
 * Call `close` when done.
 */
export async function connectSlack(): Promise<{ client: SlackClient; close: () => Promise<void> } | { off: string } | { error: string }> {
  let mods;
  try {
    mods = await Promise.all([import(`${ADAPTER}/config.js`), import(`${ADAPTER}/mcp-auth.js`), import(`${ADAPTER}/server-manager.js`)]);
  } catch (err) {
    return { off: `pi-mcp-adapter is not installed at ${ADAPTER}: ${(err as Error).message}` };
  }
  const [config, auth, manager] = mods;
  const loaded = config.loadMcpConfigWithSources(undefined, homedir());
  const def = loaded.config.mcpServers[SERVER];
  if (!def) return { off: `no "${SERVER}" server in ~/.pi/agent/mcp-adapter.json` };
  const servers = new manager.McpServerManager(homedir());
  servers.setAuthStorageOptions(auth.getAuthStorageOptions(loaded.config.settings?.oauthDir, homedir(), loaded.config.settings?.oauthCredentialStore));
  const close = () => servers.closeAll().catch(() => undefined);
  try {
    const conn = await servers.connect(SERVER, { ...def, debug: false }, AbortSignal.timeout(30_000));
    if (conn.status === "needs-auth") {
      await close();
      return { error: `The Slack sign-in expired. ${RELOGIN}` };
    }
    return { client: conn.client, close };
  } catch (err) {
    await close();
    return { error: `Could not connect to Slack: ${(err as Error).message}` };
  }
}

/** A tool answer's text. It can be JSON in a string, with escaped slashes. */
export function resultText(res: Result): string {
  return (res.content ?? []).map((c) => c.text ?? "").join("\n").replace(/\\\//g, "/");
}
