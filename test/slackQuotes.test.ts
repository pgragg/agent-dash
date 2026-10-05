import assert from "node:assert/strict";
import { test } from "node:test";
import { citedSlack, parseSlackHits } from "../shared/slackQuotes.ts";
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
