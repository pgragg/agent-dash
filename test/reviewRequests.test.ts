import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { requestReviewDrafts } from "../server/reviewDrafts.ts";
import { handle } from "../server/routes/reviewRequests.ts";
import * as db from "../server/summaries/db.ts";
import { cleanSummary, draftPrompt, fallbackMessage, reviewChannel, reviewMessage } from "../shared/reviewRequest.ts";
import type { PullRequest } from "../shared/types.ts";
import { pr } from "./helpers.ts";

db.open(join(mkdtempSync(join(tmpdir(), "agent-dash-review-")), "test.db"));

const URL1 = "https://github.com/postman-eng/cloud9-parcels-production-deployments/pull/13612";

test("the message is the team's format, and the model's phrase is cleaned to one short line", () => {
  assert.equal(reviewMessage("bind slack token env vars", URL1), `PR: bind slack token env vars ${URL1}`);
  assert.equal(cleanSummary('"bind slack token env vars."\n\nThis PR…'), "bind slack token env vars");
  assert.equal(cleanSummary(`PR: bind slack token env vars ${URL1}`), "bind slack token env vars");
  assert.equal(cleanSummary("\n\n"), "");
  assert.equal(cleanSummary("x".repeat(500)).length, 160);
  assert.equal(fallbackMessage("feat(fai): bind SLACK token env vars [FSDK-2101]", URL1), `PR: bind SLACK token env vars ${URL1}`);
  assert.equal(fallbackMessage("FSDK-1", URL1), `PR: please review ${URL1}`);
  const prompt = draftPrompt({ repo: "o/r", title: "t", body: "b".repeat(5_000), files: ["a.ts"] });
  assert.match(prompt, /write only <phrase>/);
  assert.ok(prompt.length < 4_000);
});

test("each open PR outside agent-dash is drafted once, in parallel; a failure is kept, and tried again only later", async () => {
  const prs = [pr({ url: "u/1" }), pr({ url: "u/2" }), pr({ url: "u/3", state: "merged" }), pr({ url: "u/4" }), pr({ url: "u/5", repo: "pgragg/agent-dash" })];
  const seen: string[] = [];
  let active = 0;
  let most = 0;
  let changes = 0;
  const draft = async (p: PullRequest) => {
    seen.push(p.url);
    most = Math.max(most, ++active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    if (p.url === "u/4") throw new Error("pi exited with code 1");
    return `PR: x ${p.url}`;
  };
  const now = new Date("2026-10-05T10:00:00.000Z");
  assert.deepEqual(requestReviewDrafts(prs, () => changes++, draft, now), ["u/1", "u/2", "u/4"]);
  // A second page load while they run starts nothing.
  assert.deepEqual(requestReviewDrafts(prs, () => changes++, draft, now), []);
  assert.equal(db.reviewDrafts()["u/1"].status, "in_progress");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(most, 3);
  assert.equal(changes, 3);
  assert.deepEqual(seen.sort(), ["u/1", "u/2", "u/4"]);
  const d = db.reviewDrafts();
  assert.deepEqual([d["u/1"].status, d["u/1"].text], ["done", "PR: x u/1"]);
  assert.deepEqual([d["u/4"].status, d["u/4"].error], ["failed", "pi exited with code 1"]);
  assert.equal(d["u/3"], undefined);
  assert.deepEqual(requestReviewDrafts(prs, () => {}, draft, new Date("2026-10-05T10:01:00.000Z")), []);
  assert.deepEqual(requestReviewDrafts(prs, () => {}, draft, new Date("2026-10-05T10:06:00.000Z")), ["u/4"]);
});

function call(path: string, body: unknown, headers: Record<string, string> = { "x-agent-dash": "1" }, method = "POST") {
  const req = Object.assign(Readable.from([JSON.stringify(body ?? {})]), { method, headers }) as unknown as IncomingMessage;
  const out = { code: 0, body: "" };
  const res = { writeHead: (code: number) => ((out.code = code), res), end: (b = "") => void (out.body = b) } as unknown as ServerResponse;
  return { req, res, out, url: new URL(path, "http://localhost") };
}

test("Post sends the text to the review channel as Piper, then records a review_request on the PR's tickets", async () => {
  const mine = pr({ url: URL1, tickets: ["FSDK-2101"] });
  const posted: [string, string][] = [];
  let changes = 0;
  const deps = {
    prs: async () => [mine],
    onChange: () => changes++,
    post: async (channel: string, text: string) => (posted.push([channel, text]), { ts: "1791213047.219629", permalink: "https://postman.enterprise.slack.com/archives/C0BFE2ABFA9/p1791213047219629" }),
  };
  const text = `PR: bind slack token env vars ${URL1}`;

  const guard = call("/api/review-requests", { prUrl: URL1, text }, {});
  assert.equal(await handle(guard.req, guard.res, guard.url, deps), true);
  assert.equal(guard.out.code, 403);

  const other = call("/api/review-requests", { prUrl: "https://github.com/evil/x/pull/1", text });
  await handle(other.req, other.res, other.url, deps);
  assert.equal(other.out.code, 404);

  const empty = call("/api/review-requests", { prUrl: URL1, text: "  " });
  await handle(empty.req, empty.res, empty.url, deps);
  assert.equal(empty.out.code, 400);
  assert.equal(posted.length, 0);

  const ok = call("/api/review-requests", { prUrl: URL1, text: `  ${text} ` });
  await handle(ok.req, ok.res, ok.url, deps);
  assert.equal(ok.out.code, 201);
  assert.deepEqual(posted, [[reviewChannel()!.id, text]]);
  const e = JSON.parse(ok.out.body);
  assert.deepEqual([e.eventType, e.tickets, e.prUrl, e.message, e.channel], ["review_request", ["FSDK-2101"], URL1, text, reviewChannel()!.id]);
  assert.match(e.messageUrl, /p1791213047219629$/);
  assert.equal(changes, 1);
  assert.equal(db.sdlcEventsByTicket()["FSDK-2101"][0].id, e.id);
});

test("a failed post records nothing and shows Slack's reason", async () => {
  const mine = pr({ url: "https://github.com/o/r/pull/9", tickets: ["FSDK-9"] });
  const c = call("/api/review-requests", { prUrl: mine.url, text: "PR: x" });
  await handle(c.req, c.res, c.url, {
    prs: async () => [mine],
    onChange: () => {},
    post: async () => {
      throw new Error("The Slack sign-in cannot post: it has no chat:write scope.");
    },
  });
  assert.equal(c.out.code, 502);
  assert.match(JSON.parse(c.out.body).error, /chat:write/);
  assert.equal(db.sdlcEventsByTicket()["FSDK-9"], undefined);
});

test("drafts start from the server's own PR list, and Redraft takes only one of your open PRs", async () => {
  const mine = pr({ url: "https://github.com/o/r/pull/20" });
  let drafted = 0;
  const deps = { prs: async () => [mine], onChange: () => {}, draft: async (p: PullRequest) => (drafted++, `PR: y ${p.url}`) };
  const first = call("/api/review-drafts", {});
  await handle(first.req, first.res, first.url, deps);
  assert.deepEqual(JSON.parse(first.out.body), { started: [mine.url] });
  await new Promise((r) => setTimeout(r, 10));
  const again = call(`/api/review-drafts?pr=${encodeURIComponent(mine.url)}`, {});
  await handle(again.req, again.res, again.url, deps);
  assert.deepEqual(JSON.parse(again.out.body), { started: [mine.url] });
  const bad = call(`/api/review-drafts?pr=${encodeURIComponent("https://github.com/o/r/pull/21")}`, {});
  await handle(bad.req, bad.res, bad.url, deps);
  assert.equal(bad.out.code, 404);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(drafted, 2);
});
