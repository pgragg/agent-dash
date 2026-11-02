import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { slackFixSteps, slackHealth } from "../server/sources/slack.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-dash-slack-"));

test("the Slack health is the one sign-in", () => {
  assert.deepEqual(slackHealth({ off: "x" }), { ok: true, off: true, label: "Slack" });
  assert.deepEqual(slackHealth({ ok: true }), { ok: true, label: "Slack" });
  assert.deepEqual(slackHealth({ ok: false, error: "The Slack sign-in expired." }), { ok: false, label: "Slack", error: "Slack: The Slack sign-in expired." });
});

test("Fix Slack login gives the sign-in command", () => {
  assert.equal(slackFixSteps({ reloginCommand: "pi mcp login slack" }), "Run `pi mcp login slack` in a terminal and allow the grant.");
  assert.match(slackFixSteps({ reloginCommand: "" }), /^Sign in to the slack server of pi-mcp-adapter again/);
  assert.doesNotMatch(slackFixSteps({ reloginCommand: "" }), /cookie|agent-browser|remote-debugging/);
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
