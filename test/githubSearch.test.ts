import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A fake gh on PATH: two pages of results, then an HTML 502 when GH_STUB_502 is set.
const dir = mkdtempSync(join(tmpdir(), "agent-dash-gh-search-"));
const calls = join(dir, "calls.log");
const pr = (n: number) => ({ url: `https://github.com/o/r/pull/${n}`, number: n, title: `PR ${n}`, state: "OPEN", isDraft: false, headRefName: "b", repository: { nameWithOwner: "o/r" }, commits: { nodes: [] } });
writeFileSync(join(dir, "p1.json"), JSON.stringify({ data: { search: { pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [pr(1)] } } }));
writeFileSync(join(dir, "p2.json"), JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: "C2" }, nodes: [pr(2)] } } }));
// A repo that search skips: one PR of mine, one of someone else, then one older than the window.
const recent = new Date().toISOString();
writeFileSync(join(dir, "repo.json"), JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: "R1" }, nodes: [
  { id: "MINE", updatedAt: recent, author: { login: "me" } },
  { id: "THEIRS", updatedAt: recent, author: { login: "other" } },
  { id: "OLD", updatedAt: "2000-01-01T00:00:00Z", author: { login: "me" } },
] } } } }));
writeFileSync(join(dir, "nodes.json"), JSON.stringify({ data: { nodes: [{ ...pr(9), url: "https://github.com/o/hidden/pull/9", repository: { nameWithOwner: "o/hidden" } }] } }));
writeFileSync(
  join(dir, "gh"),
  `#!/bin/sh
echo "$@" >> ${calls}
if [ -n "$GH_STUB_502" ]; then printf '<html><h1>502 Bad Gateway</h1></html>'; echo 'gh: HTTP 502' >&2; exit 1; fi
case "$*" in *"api user"*) echo me ;; *owner=o*) cat ${dir}/repo.json ;; *ids*) cat ${dir}/nodes.json ;; *after=C1*) cat ${dir}/p2.json ;; *) cat ${dir}/p1.json ;; esac
`,
);
chmodSync(join(dir, "gh"), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
const { fetchMyPrs, fetchTicketPrs } = await import("../server/sources/github.ts");

test("the PR search reads every page, with the cursor of the page before", async () => {
  writeFileSync(calls, "");
  const prs = await fetchTicketPrs("AB-1", /AB-1/g).catch(() => null);
  assert.ok(prs);
  assert.equal(readFileSync(calls, "utf8").match(/^api graphql/gm)?.length, 2);
  assert.match(readFileSync(calls, "utf8"), /after=C1/);
});

test("an HTML 502 from GitHub gives gh's HTTP line, not a JSON parse error", async () => {
  process.env.GH_STUB_502 = "1";
  try {
    await assert.rejects(fetchTicketPrs("AB-1", /AB-1/g), /gh api graphql failed: gh: HTTP 502/);
  } finally {
    delete process.env.GH_STUB_502;
  }
});

test("a repo that search skips is listed, and only my PRs in the window are read in full", async () => {
  writeFileSync(calls, "");
  const prs = await fetchMyPrs(14, /AB-1/g, ["o/hidden"]);
  assert.deepEqual(prs.map((p) => p.url), ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2", "https://github.com/o/hidden/pull/9"]);
  const log = readFileSync(calls, "utf8");
  assert.match(log, /ids\[\]=MINE/);
  assert.doesNotMatch(log, /THEIRS|after=R1/);
});
