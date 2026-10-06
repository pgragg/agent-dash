/**
 * Post one Slack message as you, through Slack's hosted MCP and your own OAuth grant:
 *
 *   echo "PR: bind slack token env vars https://github.com/…/pull/1" | node scripts/slack-post.ts --channel C0BFE2ABFA9
 *
 * Prints {"ts", "permalink"} as JSON. The server runs it when you click a review request's Post
 * button: that click is the approval. It reuses pi-mcp-adapter's sign-in,
 * because copied Slack cookies get the session revoked. The grant needs chat:write; the adapter
 * config hides the send tool from pi agents, so only this script can post.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config as dash } from "../server/config.ts";

const ADAPTER = process.env.AGENT_DASH_MCP_ADAPTER ?? join(homedir(), ".pi/agent/npm/node_modules/pi-mcp-adapter/dist");
const SERVER = "slack";
const SEND_TOOL = "slack_send_message";
const RELOGIN = dash.slack.reloginCommand ? `Run \`${dash.slack.reloginCommand}\` and allow the grant in the browser.` : "Sign in to the slack MCP server of pi-mcp-adapter again.";

async function readStdin(): Promise<string> {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({ options: { channel: { type: "string" } } });
const channel = values.channel ?? "";
if (!/^[CGD][A-Z0-9]{6,}$/.test(channel)) fail("usage: node scripts/slack-post.ts --channel <channel id> < message.txt");
const text = (await readStdin()).trim();
if (!text) fail("empty message");

const [config, auth, manager] = await Promise.all([import(`${ADAPTER}/config.js`), import(`${ADAPTER}/mcp-auth.js`), import(`${ADAPTER}/server-manager.js`)]).catch((err: Error) =>
  fail(`pi-mcp-adapter is not installed at ${ADAPTER}: ${err.message}`),
);
const loaded = config.loadMcpConfigWithSources(undefined, homedir());
const def = loaded.config.mcpServers[SERVER];
if (!def) fail(`no "${SERVER}" server in ~/.pi/agent/mcp-adapter.json`);
const servers = new manager.McpServerManager(homedir());
servers.setAuthStorageOptions(auth.getAuthStorageOptions(loaded.config.settings?.oauthDir, homedir(), loaded.config.settings?.oauthCredentialStore));

try {
  const conn = await servers.connect(SERVER, { ...def, debug: false }, AbortSignal.timeout(30_000));
  if (conn.status === "needs-auth") fail(`The Slack sign-in expired. ${RELOGIN}`);
  // The raw tool list: the adapter's excludeTools only hides the tool from pi agents.
  const { tools } = await conn.client.listTools();
  const tool = tools.find((t: { name: string }) => t.name === SEND_TOOL);
  if (!tool) fail(`The Slack sign-in cannot post: it has no chat:write scope. ${RELOGIN}`);
  const props = Object.keys(tool.inputSchema?.properties ?? {});
  const channelKey = props.includes("channel_id") ? "channel_id" : "channel";
  const textKey = props.includes("message") ? "message" : "text";
  const res = await conn.client.callTool({ name: SEND_TOOL, arguments: { [channelKey]: channel, [textKey]: text } });
  // The answer can be JSON in a string, with escaped slashes.
  const out = (res.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n").replace(/\\\//g, "/");
  if (res.isError) fail(`Slack refused the message: ${out.slice(0, 500)}`);
  const permalink = out.match(/https:\/\/[\w.-]*slack\.com\/archives\/[^\s)"'\\|>]+/)?.[0] ?? null;
  const ts = out.match(/\b(\d{10}\.\d{6})\b/)?.[1] ?? permalink?.match(/\/p(\d{10})(\d{6})/)?.slice(1).join(".") ?? null;
  console.log(JSON.stringify({ ts, permalink: permalink ?? (ts && dash.slack.workspaceUrl ? `${dash.slack.workspaceUrl}/archives/${channel}/p${ts.replace(".", "")}` : null) }));
} finally {
  await servers.closeAll().catch(() => undefined);
}
process.exit(0);
