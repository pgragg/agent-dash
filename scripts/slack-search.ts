/**
 * Search Slack messages, read-only, with the saved Slack login in the config file (slackStateFile).
 *
 *   node scripts/slack-search.ts "FSDK-2046" [count]
 *
 * Clicking through Slack's search box from a headless browser is unreliable, so this opens
 * Slack once and calls Slack's own search.messages endpoint from inside the page, with the
 * page's token and cookies. It only searches; it never posts, reacts, or marks anything read.
 * The state file is an agent-browser state with a Slack login: `agent-browser state save <file>`.
 *
 * With AGENT_DASH_SLACK_HITS set (a summary run sets it), each match is also appended to that
 * file as a JSON line, so the dashboard can quote the messages a summary links to.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { config } from "../server/config.ts";

const query = process.argv[2];
const count = Number(process.argv[3] ?? 15);
if (!query) {
  console.error('usage: node scripts/slack-search.ts "<query>" [count]');
  process.exit(2);
}

if (!config.slack.stateFile) {
  console.error("Slack search is not set up: set the Slack login state on agent-dash's Settings page.");
  process.exit(1);
}
// An Enterprise Grid org id searches every workspace; empty takes the first logged-in team.
const ORG = config.slack.orgId;
const session = `agentdash-slack-${process.pid}`;
const ab = (...args: string[]) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 60_000 });

const SEARCH = `(async () => {
  const cfg = JSON.parse(localStorage.getItem("localConfig_v2") || "{}");
  const team = (${JSON.stringify(ORG)} && (cfg.teams || {})[${JSON.stringify(ORG)}]) || Object.values(cfg.teams || {}).find((t) => t.token);
  if (!team || !team.token) return JSON.stringify({ error: "not_logged_in" });
  const fd = new FormData();
  fd.append("token", team.token);
  fd.append("query", ${JSON.stringify(query)});
  fd.append("count", ${JSON.stringify(String(count))});
  fd.append("sort", "timestamp");
  const j = await (await fetch("/api/search.messages", { method: "POST", body: fd, credentials: "include" })).json();
  if (!j.ok) return JSON.stringify({ error: j.error });
  return JSON.stringify({ total: j.messages.total, matches: j.messages.matches.map((m) => ({
    ts: m.ts, channel: m.channel && (m.channel.is_im ? "DM" : m.channel.name), user: m.username,
    text: m.text, permalink: m.permalink })) });
})()`;

try {
  ab("--state", config.slack.stateFile, "open", `https://app.slack.com/client/${ORG}`);
  ab("wait", "--load", "networkidle");
  const url = ab("get", "url").trim();
  if (!url.includes("app.slack.com/client")) {
    console.error(`Slack login expired (landed on ${url}). Save a new login to ${config.slack.stateFile}.`);
    process.exit(1);
  }
  // `eval` prints the returned string as a JSON string literal.
  const raw = ab("eval", SEARCH).trim().split("\n").pop()!;
  const res = JSON.parse(JSON.parse(raw));
  if (res.error) {
    console.error(`Slack search failed: ${res.error}`);
    process.exit(1);
  }
  console.log(`${res.total} messages match ${JSON.stringify(query)}; newest ${res.matches.length}:`);
  const hits = process.env.AGENT_DASH_SLACK_HITS;
  if (hits) appendFileSync(hits, res.matches.map((m: Record<string, unknown>) => `${JSON.stringify({ permalink: m.permalink, channel: m.channel, user: m.user, ts: m.ts, text: String(m.text).slice(0, 2000) })}\n`).join(""));
  for (const m of res.matches) {
    const when = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
    console.log(`\n[${when}] #${m.channel} @${m.user}: ${String(m.text).replace(/\s+/g, " ").slice(0, 400)}\n  ${m.permalink}`);
  }
} finally {
  try {
    ab("close");
  } catch {
    // The session may not have started.
  }
}
