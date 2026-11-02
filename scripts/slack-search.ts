/**
 * Search Slack messages, read-only, through Slack's hosted MCP and your own OAuth grant:
 *
 *   node scripts/slack-search.ts "ABC-2046" [count]
 *
 * It reuses pi-mcp-adapter's sign-in, the same one as slack-post.ts, because copied Slack cookies
 * get the session revoked. It only calls the search tool; it never posts, reacts, or marks
 * anything read. Words such as `in:#channel` or `after:2026-10-01` are Slack search filters.
 *
 * With AGENT_DASH_SLACK_HITS set (a summary run sets it), each match is also appended to that
 * file as a JSON line, so the dashboard can quote the messages a summary links to.
 */
import { appendFileSync } from "node:fs";
import { parseSlackSearch } from "../shared/slackQuotes.ts";
import { connectSlack } from "./slackMcp.ts";

const SEARCH_TOOL = "slack_search_public_and_private";

const query = process.argv[2];
// The tool returns at most 20 matches.
const count = Math.min(Number(process.argv[3] ?? 15), 20);
if (!query) {
  console.error('usage: node scripts/slack-search.ts "<query>" [count]');
  process.exit(2);
}

// The tool takes words and quoted phrases apart from the `name:value` filters.
const terms = query.match(/-?"[^"]*"|\S+/g) ?? [];
const isFilter = (t: string) => /^-?[a-z_]+:\S/i.test(t);
const keywords = terms.filter((t) => !isFilter(t));
const filters = terms.filter(isFilter).join(" ");

const slack = await connectSlack();
if ("off" in slack) {
  console.error(`Slack search is not set up: ${slack.off}`);
  process.exit(1);
}
if ("error" in slack) {
  console.error(slack.error);
  process.exit(1);
}

try {
  const res = await slack.client.callTool({
    name: SEARCH_TOOL,
    arguments: { keywords, filters, sort: "timestamp", sort_dir: "desc", limit: count, include_context: false, include_bots: true },
  });
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  if (res.isError) {
    console.error(`Slack search failed: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  const matches = parseSlackSearch(text);
  console.log(`${matches.length} newest messages that match ${JSON.stringify(query)}:`);
  const hits = process.env.AGENT_DASH_SLACK_HITS;
  if (hits) appendFileSync(hits, matches.map((m) => `${JSON.stringify({ ...m, text: m.text.slice(0, 2000) })}\n`).join(""));
  for (const m of matches) {
    const when = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
    console.log(`\n[${when}] ${m.channel === "DM" ? "DM" : `#${m.channel}`} @${m.user}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}\n  ${m.permalink}`);
  }
} finally {
  await slack.close();
}
process.exit(0);
