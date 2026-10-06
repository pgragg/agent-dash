import assert from "node:assert/strict";
import { test } from "node:test";
import { rankAttention } from "../server/attention.ts";
import { actionCandidates } from "../server/actions.ts";
import { feedbackOf } from "../server/sources/github.ts";
import { toAddressCount } from "../shared/feedback.ts";
import { verbFor } from "../shared/prVerbs.ts";
import { NOW, minutesAgo, pr } from "./helpers.ts";

const at = (m: number) => minutesAgo(m);
const thread = (login: string, m: number, url: string) => ({ isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login, __typename: login.endsWith("bot") ? "Bot" : "User" }, createdAt: at(m), url }] } });

/** sdk-gen-fern-platform#172 as the board's search saw it on 2026-10-06. */
const node172 = {
  author: { login: "pgragg" },
  reviews: { nodes: [{ author: { login: "arielitovsky", __typename: "User" }, state: "APPROVED", body: "LGTM, but look at the bot's comment first", submittedAt: at(60), url: "https://github.com/o/r/pull/172#pullrequestreview-1" }] },
  comments: { nodes: [] },
  reviewThreads: {
    nodes: [
      thread("cursor-bot", 120, "u1"),
      thread("cursor-bot", 119, "u2"),
      thread("cursor-bot", 118, "u3"),
      thread("cursor-bot", 117, "u4"),
      thread("arielitovsky", 116, "u5"),
      { ...thread("arielitovsky", 115, "u6"), isResolved: true },
      thread("pgragg", 114, "u7"),
    ],
  },
  commits: { nodes: [{ commit: { committedDate: at(30) } }] },
};

test("the board counts feedback with the panel's rule: a review body and threads whose last word is not the author's", () => {
  const f = feedbackOf(node172);
  assert.equal(f.threads.length, 6, "resolved threads are left out");
  assert.equal(toAddressCount({ ...f, addressed: [] }), 6);
  // A mark on the panel counts on the board too.
  assert.equal(toAddressCount({ ...f, addressed: ["u1", "https://github.com/o/r/pull/172#pullrequestreview-1"] }), 4);
});

test("an approval with feedback to address is not 'merge it'", () => {
  const [item] = rankAttention([], [pr({ number: 172, repo: "o/sdk-gen-fern-platform", reviewDecision: "APPROVED", toAddress: 6 })], [], NOW);
  assert.equal(item.kind, "approved_with_feedback");
  assert.equal(item.reason, "sdk-gen-fern-platform#172: approved, 6 comments to address");
  assert.ok(item.score > 70 && item.score < 80);
  assert.equal(verbFor(item, { url: "u", repo: "o/r", number: 172 }), null, "its button is a link to the panel, not an agent");
  assert.equal(actionCandidates({ attention: [{ ...item, ticketUrl: null }], myTickets: [], otherTickets: [], summaries: {} }).length, 1);
});

test("an approval with an empty body and no open thread is still 'approved and green — merge it'", () => {
  const f = feedbackOf({ ...node172, reviews: { nodes: [{ ...node172.reviews.nodes[0], body: "" }] }, reviewThreads: { nodes: [] } });
  const toAddress = toAddressCount({ ...f, addressed: [] });
  assert.equal(toAddress, 0);
  const [item] = rankAttention([], [pr({ reviewDecision: "APPROVED", toAddress })], [], NOW);
  assert.equal(item.kind, "ready_to_merge");
  assert.match(item.reason, /approved and green — merge it/);
});
