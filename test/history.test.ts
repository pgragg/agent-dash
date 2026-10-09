import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHistory } from "../server/model.ts";
import { parseSession, transcriptTurns } from "../server/sources/sessions.ts";
import { filterHistory, groupByDay } from "../web/src/history.ts";
import { boardHash, newlyWaiting, runsOf, snapshot } from "../web/src/notify.ts";
import { NOW, PATTERN, header, jsonl, minutesAgo, name, pr, reply, run, ticket, toolCall, toolResult, user } from "./helpers.ts";

const secondsAgo = (s: number) => new Date(NOW - s * 1000).toISOString();

test("a transcript keeps prompts and replies in order, drops tool traffic, and cuts a huge turn", () => {
  const raw = jsonl(header(), user("fix FSDK-9"), toolCall("t1", "cat big.log"), toolResult("t1", "SECRET TOOL OUTPUT"), reply("Fixed it."), user("x".repeat(50)));
  const turns = transcriptTurns(raw, 20);
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"]);
  assert.equal(turns[1].text, "Fixed it.");
  assert.ok(!JSON.stringify(turns).includes("SECRET TOOL OUTPUT"));
  assert.match(turns[2].text, /^x{20}\n\n\[…cut…\]$/);
});

test("history has every chat with no time window, newest first, without the whole last message", () => {
  const old = parseSession(jsonl(header("old"), name("ancient FSDK-3"), user("go"), reply("done")), "/a.jsonl", new Date(NOW - 90 * 86_400_000), PATTERN)!;
  const fresh = parseSession(jsonl(header("new"), name("New one"), user("go"), reply("ok")), "/b.jsonl", new Date(NOW - 60_000), PATTERN)!;
  const unused = parseSession(jsonl(header("empty")), "/c.jsonl", new Date(NOW), PATTERN)!;
  const h = buildHistory([old, fresh, unused], new Map(), [], NOW);
  assert.deepEqual(h.map((r) => r.sessionId), ["new", "old"]);
  assert.ok(!("lastMessage" in h[0]));
  assert.deepEqual(h[1].tickets, ["FSDK-3"]);
});

test("history runs take the tickets of the PRs they opened", () => {
  const url = "https://github.com/o/r/pull/7";
  const s = parseSession(jsonl(header(), user("open a PR"), toolCall("t1", "gh pr create --fill"), toolResult("t1", url), reply("opened")), "/a.jsonl", new Date(NOW), PATTERN)!;
  const h = buildHistory([s], new Map(), [pr({ url, tickets: ["FSDK-7"] })], NOW);
  assert.deepEqual(h[0].tickets, ["FSDK-7"]);
});

test("search needs every word, across name, prompt, reply, folder and tickets", () => {
  const runs = [run({ sessionId: "a", name: "Fix venus", cwd: "/w/sdk-gen-venus", tickets: ["FSDK-1"] }), run({ sessionId: "b", name: "Docs publish", lastReply: "runner reached FDR" })];
  assert.deepEqual(filterHistory(runs, "venus fsdk-1").map((r) => r.sessionId), ["a"]);
  assert.deepEqual(filterHistory(runs, "FDR runner").map((r) => r.sessionId), ["b"]);
  assert.deepEqual(filterHistory(runs, "venus fdr"), []);
  assert.equal(filterHistory(runs, "  ").length, 2);
});

test("day groups: Today, Yesterday, then dates, in the input order", () => {
  const runs = [run({ sessionId: "a", lastActivityAt: minutesAgo(5) }), run({ sessionId: "b", lastActivityAt: minutesAgo(60 * 24 + 5) }), run({ sessionId: "c", lastActivityAt: minutesAgo(60 * 24 * 5) })];
  const g = groupByDay(runs, NOW);
  assert.deepEqual(g.slice(0, 2).map((x) => x.label), ["Today", "Yesterday"]);
  assert.equal(g.length, 3);
  assert.deepEqual(g.map((x) => x.runs[0].sessionId), ["a", "b", "c"]);
});

test("a notification goes out when a long run starts to wait, never on page load", () => {
  const working = run({ sessionId: "s", status: "working", statusSince: secondsAgo(120) });
  const waiting = run({ sessionId: "s", status: "awaiting_input", statusSince: secondsAgo(0) });
  assert.deepEqual(newlyWaiting(null, [waiting]), []);
  assert.deepEqual(newlyWaiting(snapshot([working]), [waiting]).map((r) => r.sessionId), ["s"]);
  // Already waiting before: no news.
  assert.deepEqual(newlyWaiting(snapshot([waiting]), [waiting]), []);
});

test("no notification for a short run, a reply stopped with Esc, a guessed status, or a closed tab", () => {
  const before = snapshot([run({ sessionId: "s", status: "working", statusSince: secondsAgo(30) })]);
  const waiting = (over = {}) => run({ sessionId: "s", status: "awaiting_input", statusSince: secondsAgo(0), ...over });
  assert.deepEqual(newlyWaiting(before, [waiting()]), [], "30 s is short");
  const long = snapshot([run({ sessionId: "s", status: "working", statusSince: secondsAgo(300) })]);
  assert.deepEqual(newlyWaiting(long, [waiting({ stoppedByUser: true })]), []);
  assert.deepEqual(newlyWaiting(long, [waiting({ statusSource: "heuristic" })]), []);
  assert.deepEqual(newlyWaiting(long, [run({ sessionId: "s", status: "finished" })]), []);
});

test("every dashboard run counts once, and a click goes to the run's board entry", () => {
  const r = run({ sessionId: "s", tickets: ["FSDK-1", "FSDK-2"] });
  const d = { myTickets: [{ ticket: ticket(), runs: [r], prs: [], threads: {} }], otherTickets: [{ ticket: ticket({ key: "FSDK-2" }), runs: [r], prs: [], threads: {} }], unlinkedRuns: [run({ sessionId: "u" })] };
  assert.deepEqual(runsOf(d).map((x) => x.sessionId), ["s", "u"]);
  assert.equal(boardHash(r), "#/t%3AFSDK-1");
  assert.equal(boardHash(run({ sessionId: "u" })), "#/r%3Au");
});
