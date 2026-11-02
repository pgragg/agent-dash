/**
 * Post one Slack message as you, through Slack's hosted MCP and your own OAuth grant:
 *
 *   echo "PR: bind slack token env vars https://github.com/…/pull/1" | node scripts/slack-post.ts --channel C0BFE2ABFA9
 *
 * Prints {"ts", "permalink"} as JSON. The server runs it when you click a review request's Post
 * button: that click is the approval. It reuses pi-mcp-adapter's sign-in,
 * because copied Slack cookies get the session revoked. The grant needs chat:write; the adapter
 * config hides the send tool from pi agents, so only this script can post.
 *
 *   node scripts/slack-post.ts --check
 *
 * Posts nothing: prints {"ok":true} when the grant can post, or {"off":"<why>"} when posting is
 * not set up, and fails with the reason otherwise. The top bar's Slack health runs it.
 */
import { parseArgs } from "node:util";
import { config as dash } from "../server/config.ts";
import { connectSlack, RELOGIN, resultText } from "./slackMcp.ts";

const SEND_TOOL = "slack_send_message";

async function readStdin(): Promise<string> {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({ options: { channel: { type: "string" }, check: { type: "boolean" } } });
const check = values.check ?? false;
const channel = values.channel ?? "";
if (!check && !/^[CGD][A-Z0-9]{6,}$/.test(channel)) fail("usage: node scripts/slack-post.ts --channel <channel id> < message.txt");
const text = check ? "" : (await readStdin()).trim();
if (!check && !text) fail("empty message");

const slack = await connectSlack();
// A missing adapter or server means posting is not set up: not a failure for --check.
if ("off" in slack) {
  if (!check) fail(slack.off);
  console.log(JSON.stringify({ off: slack.off }));
  process.exit(0);
}
if ("error" in slack) fail(slack.error);

try {
  // The raw tool list: the adapter's excludeTools only hides the tool from pi agents.
  const { tools } = await slack.client.listTools();
  const tool = tools.find((t) => t.name === SEND_TOOL);
  if (!tool) fail(`The Slack sign-in cannot post: it has no chat:write scope. ${RELOGIN}`);
  if (check) {
    console.log(JSON.stringify({ ok: true }));
    process.exit(0);
  }
  const props = Object.keys(tool.inputSchema?.properties ?? {});
  const channelKey = props.includes("channel_id") ? "channel_id" : "channel";
  const textKey = props.includes("message") ? "message" : "text";
  const res = await slack.client.callTool({ name: SEND_TOOL, arguments: { [channelKey]: channel, [textKey]: text } });
  const out = resultText(res);
  if (res.isError) fail(`Slack refused the message: ${out.slice(0, 500)}`);
  const permalink = out.match(/https:\/\/[\w.-]*slack\.com\/archives\/[^\s)"'\\|>]+/)?.[0] ?? null;
  const ts = out.match(/\b(\d{10}\.\d{6})\b/)?.[1] ?? permalink?.match(/\/p(\d{10})(\d{6})/)?.slice(1).join(".") ?? null;
  console.log(JSON.stringify({ ts, permalink: permalink ?? (ts && dash.slack.workspaceUrl ? `${dash.slack.workspaceUrl}/archives/${channel}/p${ts.replace(".", "")}` : null) }));
} finally {
  await slack.close();
}
process.exit(0);
