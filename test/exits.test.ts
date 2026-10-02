import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyHref, parseExit, sectionOf } from "../shared/exits.ts";
import * as exits from "../server/exits.ts";
import { PATTERN } from "./helpers.ts";

exits.open(join(mkdtempSync(join(tmpdir(), "agent-dash-exits-")), "test.db"));

test("an href gives the exit kind, host, and the Jira key when it has one", () => {
  assert.deepEqual(classifyHref("https://github.com/postman-eng/repo/pull/12/files"), { kind: "github_pr", host: "github.com", ticket: null });
  assert.deepEqual(classifyHref("https://postmanlabs.atlassian.net/browse/FSDK-7"), { kind: "jira", host: "postmanlabs.atlassian.net", ticket: "FSDK-7" });
  assert.deepEqual(classifyHref("https://postman.enterprise.slack.com/archives/C1/p2"), { kind: "slack", host: "postman.enterprise.slack.com", ticket: null });
  // A GitHub page that is not a PR is a plain link out.
  assert.equal(classifyHref("https://github.com/postman-eng/repo/actions/runs/1").kind, "other_url");
  assert.equal(classifyHref("https://notslack.com/x").kind, "other_url");
  assert.deepEqual(classifyHref("not a url"), { kind: "other_url", host: null, ticket: null });
});

test("the section is the nearest known class, and 'page' when none is known", () => {
  assert.equal(sectionOf(["key-link", "ws-meta", "ws-head", "workspace"]), "workspace header");
  assert.equal(sectionOf(["", "agent-message clamped", "card agent tone-border-muted", "workspace"]), "agent message");
  assert.equal(sectionOf(["pr-row closed", "card flush", "stack"]), "pr row");
  assert.equal(sectionOf(["btn ghost small", "h-row", "h-list"]), "history row");
  assert.equal(sectionOf(["steps", "card next-steps"]), "next steps");
  assert.equal(sectionOf(["foo", "bar"]), "page");
});

test("a posted exit needs a known kind; long fields are cut and unknown keys dropped", () => {
  assert.equal(parseExit({ kind: "fax" }, PATTERN), null);
  assert.equal(parseExit("jira", PATTERN), null);
  assert.deepEqual(parseExit({ kind: "jira", host: "X.atlassian.net", view: "board", section: "workspace header", ticket: "FSDK-1" }, PATTERN), {
    kind: "jira",
    host: "x.atlassian.net",
    view: "board",
    section: "workspace header",
    ticket: "FSDK-1",
  });
  const odd = parseExit({ kind: "slack", host: 5, view: "admin", section: "s".repeat(100), ticket: "ABC-1" }, PATTERN)!;
  assert.deepEqual(odd, { kind: "slack", host: null, view: null, section: "s".repeat(40), ticket: null });
});

test("counts group by kind and section inside the window, most used first", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000);
  const e = (kind: "jira" | "github_pr" | "iterm_focus", section: string | null) => ({ kind, host: null, view: null, section, ticket: null });
  exits.recordExit(e("jira", "workspace header"), at(1));
  exits.recordExit(e("jira", "workspace header"), at(2));
  exits.recordExit(e("github_pr", "pr row"), at(3));
  exits.recordExit(e("iterm_focus", null), at(0.5));
  exits.recordExit(e("github_pr", "pr row"), at(10)); // outside 7 days
  assert.deepEqual(
    exits.exitCounts(7, now).map((c) => ({ ...c })),
    [
      { kind: "jira", section: "workspace header", count: 2 },
      { kind: "github_pr", section: "pr row", count: 1 },
      { kind: "iterm_focus", section: "", count: 1 },
    ],
  );
  assert.equal(exits.exitCounts(30, now).find((c) => c.kind === "github_pr")?.count, 2);
});
