import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildConfig, effectiveSettings, readSettingsFile, ticketPatternOf } from "../server/config.ts";
import { handle } from "../server/routes/settings.ts";
import { DEFAULT_SETTINGS, validateSettings } from "../shared/settings.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-dash-settings-"));

test("a fresh clone has no Jira, no Slack, no local tickets, and links no ticket keys", () => {
  const { settings, exists } = readSettingsFile(join(dir, "missing.json"));
  assert.equal(exists, false);
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  const c = buildConfig(settings);
  assert.equal(c.jira.server, "");
  assert.equal(c.localTicketsDir, "");
  assert.equal(c.slack.stateFile, "");
  assert.equal("FSDK-12 ABC-1".match(c.ticketPattern), null);
});

test("the file sets the values, ~ expands, and an env var wins over the file", () => {
  const file = join(dir, "a.json");
  writeFileSync(file, JSON.stringify({ jiraServer: "https://x.atlassian.net/", jiraTokenFile: "~/secrets/jira.env", ticketProjects: ["ABC", "AD"], ignoreTickets: ["ABC-1"], port: 7001 }));
  const { settings } = readSettingsFile(file);
  assert.equal(settings.jiraServer, "https://x.atlassian.net");
  const c = buildConfig(effectiveSettings(settings, { AGENT_DASH_PORT: "7799", AGENT_DASH_PROJECTS: "ABC|XYZ" }));
  assert.equal(c.port, 7799);
  assert.equal(c.jira.tokenFile, join(homedir(), "secrets/jira.env"));
  assert.deepEqual("ABC-1 ABC-12 XYZ-3 AD-4".match(c.ticketPattern), ["ABC-12", "XYZ-3"]);
});

test("a bad value is refused with a reason, and a bad value in the file keeps its default", () => {
  const { errors } = validateSettings({ port: "0", ticketProjects: "ABC, lower", jiraServer: "x.atlassian.net", slackOrgId: "nope", piAuth: "a\nb" });
  assert.deepEqual(Object.keys(errors).sort(), ["jiraServer", "piAuth", "port", "slackOrgId", "ticketProjects"]);
  const file = join(dir, "bad.json");
  writeFileSync(file, JSON.stringify({ port: -1, jiraLogin: "me@x.com" }));
  const { settings } = readSettingsFile(file);
  assert.equal(settings.port, DEFAULT_SETTINGS.port);
  assert.equal(settings.jiraLogin, "me@x.com");
});

test("ticket patterns escape nothing surprising and skip ignored keys in any position", () => {
  assert.deepEqual("FSDK-1 FSDK-10 EFSUP-2".match(ticketPatternOf(["FSDK", "EFSUP"], ["FSDK-1"])), ["FSDK-10", "EFSUP-2"]);
});

const file = join(dir, "route.json");
const server = createServer(async (req, res) => {
  if (!(await handle(req, res, new URL(req.url ?? "/", "http://localhost"), file))) res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings`;

test("Save needs the header, refuses a bad value without writing, and writes the whole file", async () => {
  assert.equal((await fetch(base, { method: "POST", body: "{}" })).status, 403);
  const post = (body: unknown) => fetch(base, { method: "POST", headers: { "X-Agent-Dash": "1" }, body: JSON.stringify(body) });
  const bad = await post({ jiraServer: "nope" });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).errors.jiraServer);
  assert.equal((await (await fetch(base)).json()).exists, false);

  const ok = await post({ jiraServer: "https://x.atlassian.net", ticketProjects: "ABC, AD" });
  assert.equal(ok.status, 200);
  const state = await ok.json();
  assert.equal(state.exists, true);
  assert.deepEqual(state.saved.ticketProjects, ["ABC", "AD"]);
  // The running server loaded other values, so it says to restart.
  assert.equal(state.restartNeeded, true);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.jiraServer, "https://x.atlassian.net");
  assert.equal(written.port, 7777);
});
