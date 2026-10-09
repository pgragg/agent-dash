import assert from "node:assert/strict";
import { test } from "node:test";
import { hideUrls, promptTitle, runTitle } from "../shared/runTitle.ts";

const prompt =
  "Update wiki that we can find the source of truths for databases here: https://start.1password.com/open/i?a=ABC&v=DEF&i=GHI&h=postman.1password.com (for Fern databases) https://start.1password.com/open/i?a=XYZ";

test("every URL shows as its host in brackets", () => {
  assert.equal(hideUrls("see https://github.com/pgragg/agent-dash/pull/12, then http://user:pw@localhost:7777/#/x."), "see [github.com], then [localhost:7777].");
  assert.equal(hideUrls("no links here"), "no links here");
});

test("a run with no title yet shows its first prompt without URLs, cut to 80 characters", () => {
  const t = promptTitle(prompt);
  assert.ok(t.length <= 80, t);
  assert.doesNotMatch(t, /https?:\/\//);
  assert.equal(t, "Update wiki that we can find the source of truths for databases here: [start.1p…");
  assert.equal(promptTitle("short  prompt"), "short prompt");
});

test("the session name wins, then the drafted title, then the cleaned prompt", () => {
  assert.equal(runTitle({ name: "AD-60: Short titles", title: "Other", firstPrompt: prompt }), "AD-60: Short titles");
  assert.equal(runTitle({ name: null, title: "Wiki: database sources of truth", firstPrompt: prompt }), "Wiki: database sources of truth");
  assert.equal(runTitle({ name: null, title: null, firstPrompt: prompt }), promptTitle(prompt));
  assert.equal(runTitle({ name: "FSDK-1: move it (https://postmanlabs.atlassian.net/browse/FSDK-1)", firstPrompt: prompt }), "FSDK-1: move it ([postmanlabs.atlassian.net])");
});
