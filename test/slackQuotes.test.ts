import assert from "node:assert/strict";
import { test } from "node:test";
import { citedSlack, parseSlackHits, parseSlackSearch } from "../shared/slackQuotes.ts";
import type { SlackQuote } from "../shared/types.ts";

const hit = (channel: string, p: string, text: string, host = "postman"): SlackQuote => ({
  permalink: `https://${host}.slack.com/archives/${channel}/p${p}?thread_ts=1.2&cid=${channel}`,
  channel: "sdk-gen",
  user: "ada",
  ts: "1790000000.000100",
  text,
});

test("only the messages that the summary links to, in its order, once each", () => {
  const hits = [hit("C1", "111", "first"), hit("C2", "222", "second"), hit("C3", "333", "not cited")];
  const summary = "1. Piper: answer https://postman.slack.com/archives/C2/p222 today.\n2. See [thread](https://postman.slack.com/archives/C1/p111?thread_ts=1) and https://postman.slack.com/archives/C2/p222 again.";
  assert.deepEqual(
    citedSlack(summary, hits).map((h) => h.text),
    ["second", "first"],
  );
});

test("a link to another Slack host still matches the same message", () => {
  const hits = [hit("C1", "111", "grid", "postman-enterprise")];
  assert.equal(citedSlack("https://postman.slack.com/archives/C1/p111", hits).length, 1);
});

test("a summary with no Slack links quotes nothing", () => {
  assert.deepEqual(citedSlack("**State:** fine. https://github.com/o/r/pull/1", [hit("C1", "111", "x")]), []);
});

test("hit lines parse, and a broken line is skipped", () => {
  const good = JSON.stringify({ permalink: "https://x.slack.com/archives/C1/p1", channel: "c", user: "u", ts: "1", text: "hi" });
  assert.deepEqual(parseSlackHits(`${good}\n{"permalink":"half\n\n`), [{ permalink: "https://x.slack.com/archives/C1/p1", channel: "c", user: "u", ts: "1", text: "hi" }]);
});

test("the Slack MCP search answer becomes one quote per result", () => {
  const results = [
    "# Search Results for: \n\n## Messages (2 results)",
    "### Result 1 of 2\nChannel: #team-docs (ID: C05E0S0A9SN)\nFrom: Ada Lovelace <ada@acme.com> (ID: U1) \nTime: 2026-11-02 13:38:08 EST\nMessage_ts: 1793644688.424259\nPermalink: [link](https://acme.slack.com/archives/C05E0S0A9SN/p1793644688424259?thread_ts=1.2&cid=C05E0S0A9SN)\nText: \nFirst line.\n\nSecond line.\nContext before: \n- From: Bob\n  older\n\n---\n",
    "### Result 2 of 2\nChannel: DM (ID: D0B)\nFrom: Jira (ID: U4)  [BOT]\nMessage_ts: 1793647096.743499\nPermalink: [link](https://acme.slack.com/archives/D0B/p1793647096743499)\nText: \nA bot.\n\n---\n",
    "### Result 3 of 3\nChannel: #x (ID: C1)\nText: \nno permalink\n",
  ].join("\n");
  // The answer is JSON whose `results` is markdown, with escaped slashes.
  const quotes = parseSlackSearch(JSON.stringify({ results, pagination_info: "" }).replace(/\//g, "\\/"));
  assert.deepEqual(quotes, [
    { permalink: "https://acme.slack.com/archives/C05E0S0A9SN/p1793644688424259?thread_ts=1.2&cid=C05E0S0A9SN", channel: "team-docs", user: "Ada Lovelace", ts: "1793644688.424259", text: "First line.\n\nSecond line." },
    { permalink: "https://acme.slack.com/archives/D0B/p1793647096743499", channel: "DM", user: "Jira", ts: "1793647096.743499", text: "A bot." },
  ]);
});
