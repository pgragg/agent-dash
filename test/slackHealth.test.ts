import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { searchLogin, slackFixSteps, slackHealth, slackLoginGap } from "../server/sources/slack.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-dash-slack-"));
const state = (cookies: unknown[]) => {
  const f = join(dir, `state-${Math.random()}.json`);
  writeFileSync(f, JSON.stringify({ cookies, origins: [] }));
  return f;
};
const now = Date.parse("2026-10-08T12:00:00Z");
const ok = (h: object) => "ok" in h && h.ok;

test("the saved search login is read from its file only", () => {
  assert.deepEqual(searchLogin("", now), { off: "no Slack login state is set" });
  assert.equal(ok(searchLogin(join(dir, "missing.json"), now)), false);
  assert.equal(ok(searchLogin(state([{ name: "d", domain: ".slack.com", expires: now / 1000 + 3600 }]), now)), true);
  assert.equal(ok(searchLogin(state([{ name: "d", domain: ".slack.com", expires: -1 }]), now)), true);
  assert.match(String((searchLogin(state([{ name: "d", domain: ".slack.com", expires: now / 1000 - 1 }]), now) as { error: string }).error), /expired/);
  assert.equal(ok(searchLogin(state([{ name: "d", domain: ".evil.com", expires: -1 }]), now)), false);
});

test("a Gaps line that says the Slack login failed is a login gap", () => {
  for (const s of [
    "**Gaps:** Slack login expired, so I did not search Slack.",
    "**Gaps:** The Slack search failed because the login expired.",
    "**State:** x\n**Gaps:** Slack search failed (login expired).",
  ])
    assert.equal(slackLoginGap(s), true, s);
  for (const s of ["**Gaps:** Jira login expired.", "**Gaps:** none", "Slack login expired, but no gaps line", "**Blockers:** Slack login expired.\n**Gaps:** none"]) assert.equal(slackLoginGap(s), false, s);
});

test("one Slack health for both logins", () => {
  const good = { ok: true as const, savedAt: "2026-10-05T10:00:00Z" };
  assert.deepEqual(slackHealth({ off: "x" }, { off: "y" }, null, null), { ok: true, off: true, label: "Slack" });
  assert.deepEqual(slackHealth(good, { ok: true }, null, null), { ok: true, label: "Slack" });
  const post = slackHealth({ off: "x" }, { ok: false, error: "The Slack sign-in expired." }, null, null);
  assert.equal(post.ok, false);
  assert.match(post.error!, /^Post to Slack: The Slack sign-in expired\.$/);
  // A draft's gap after the last save takes Slack down, until a new save or a fix.
  const gap = { at: "2026-10-08T22:41:36Z", ticket: "FSDK-2073" };
  assert.match(slackHealth(good, { ok: true }, gap, null).error!, /FSDK-2073 next-steps draft .* expired/);
  assert.equal(slackHealth({ ...good, savedAt: "2026-10-08T23:00:00Z" }, { ok: true }, gap, null).ok, true);
  assert.equal(slackHealth(good, { ok: true }, gap, "2026-10-08T23:00:00Z").ok, true);
  // With search off, a gap is not a Slack failure.
  assert.equal(slackHealth({ off: "x" }, { ok: true }, gap, null).ok, true);
});

test("Fix Slack login gives the steps for only the half that failed", () => {
  const slack = { stateFile: join(dir, "state.json"), reloginCommand: "" };
  const good = { ok: true as const, savedAt: "2026-10-05T10:00:00Z" };
  const gap = { at: "2026-10-08T22:41:36Z", ticket: "FSDK-2073" };
  const search = slackFixSteps(slackHealth(good, { ok: true }, gap, null), slack);
  assert.match(search, /^For Slack search, .*chrome:\/\/inspect\/#remote-debugging.*--auto-connect state save .*slack\\\\\.com\$.*state\.json"/);
  assert.doesNotMatch(search, /Post to Slack|pi-auth/);
  // A README next to the state file is named, so the user can read the full steps.
  writeFileSync(join(dir, "README.md"), "");
  assert.match(slackFixSteps(slackHealth(good, { ok: true }, gap, null), slack), / More in .*README\.md\.$/);
  const post = slackFixSteps(slackHealth(good, { ok: false, error: "The Slack sign-in expired." }, null, null), { ...slack, reloginCommand: "pi mcp login slack" });
  assert.equal(post, "For Post to Slack, run `pi mcp login slack` in a terminal and allow the grant.");
  const both = slackFixSteps(slackHealth({ ok: false, error: "the saved Slack login expired" }, { ok: false, error: "x" }, null, null), slack);
  assert.match(both, /^For Slack search, .* For Post to Slack, /);
});

test("slack-post.ts --check posts nothing and says off, ok, or why not", async () => {
  const { postLogin } = await import("../server/sources/slack.ts");
  const adapter = (servers: string, conn: string) => {
    const a = mkdtempSync(join(dir, "adapter-"));
    writeFileSync(join(a, "config.js"), `export const loadMcpConfigWithSources = () => ({ config: { mcpServers: ${servers}, settings: {} } });`);
    writeFileSync(join(a, "mcp-auth.js"), "export const getAuthStorageOptions = () => ({});");
    writeFileSync(
      join(a, "server-manager.js"),
      `export class McpServerManager { setAuthStorageOptions() {} async closeAll() {} async connect() { return ${conn}; } }`,
    );
    return a;
  };
  const tools = (names: string[]) => `{ status: "connected", client: { listTools: async () => ({ tools: ${JSON.stringify(names.map((name) => ({ name })))} }), callTool: async () => { throw new Error("posted"); } } }`;
  const cases: [string, unknown][] = [
    [join(dir, "none"), "off"],
    [adapter("{}", "null"), "off"],
    [adapter("{ slack: {} }", `{ status: "needs-auth" }`), /sign-in expired/],
    [adapter("{ slack: {} }", tools(["slack_read_thread"])), /no chat:write scope/],
    [adapter("{ slack: {} }", tools(["slack_send_message"])), "ok"],
  ];
  for (const [dirPath, want] of cases) {
    process.env.AGENT_DASH_MCP_ADAPTER = dirPath;
    const h = await postLogin();
    if (want === "off") assert.ok("off" in h, dirPath);
    else if (want === "ok") assert.deepEqual(h, { ok: true });
    else assert.match((h as { error: string }).error, want as RegExp);
  }
  delete process.env.AGENT_DASH_MCP_ADAPTER;
});
