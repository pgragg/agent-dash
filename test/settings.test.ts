import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildConfig, effectiveSettings, findConfigFile, readSettingsFile, setupNeeded, ticketPatternOf } from "../server/config.ts";
import { handle } from "../server/routes/settings.ts";
import { DEFAULT_SETTINGS, validateSettings } from "../shared/settings.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-dash-settings-"));

test("a fresh clone has the company's Jira and Slack, but no login, paths, review channel or ticket keys", () => {
  const { settings, exists } = readSettingsFile(join(dir, "missing.json"));
  assert.equal(exists, false);
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  const c = buildConfig(settings);
  assert.equal(c.jira.server, "https://postmanlabs.atlassian.net");
  assert.equal(c.jira.login, "");
  assert.equal(c.settings.reviewChannelId, "");
  assert.deepEqual(c.settings.environments, ["localhost", "postman_beta", "postman_prod"]);
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

test("the setup banner names what a new user still has to set", () => {
  const set = (over: object) => buildConfig({ ...DEFAULT_SETTINGS, ...over });
  assert.deepEqual(setupNeeded(set({ jiraServer: "" }), {}), ["the Jira server", "your ticket projects", "your first name"]);
  assert.deepEqual(setupNeeded(set({}), {}), ["your Jira login", "a Jira token file", "your ticket projects", "your first name"]);
  // The token can come from the env instead of a file.
  assert.deepEqual(setupNeeded(set({ jiraLogin: "me@x.com", ticketProjects: ["ABC"], userName: "Sam" }), { JIRA_API_TOKEN: "t" }), []);
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

test("team settings: no name says the user, no channel turns review requests off, and only enabled environments are offered", async () => {
  const { gistPrompt } = await import("../shared/conversationSummary.ts");
  const { wantsReviewRequest } = await import("../shared/reviewRequest.ts");
  const { deployStageOf, enabledEnvironments, sharedEnvs } = await import("../shared/sdlc.ts");
  const { DEFAULT_TEAM, setTeam, team } = await import("../shared/team.ts");
  const saved = { ...team };
  try {
    setTeam({ ...DEFAULT_TEAM, deployRepoBeta: "acme/deploy-beta" });
    assert.match(gistPrompt("awaiting_input", "…"), /between the user \(USER\).*waits for the user\./s);
    assert.equal(wantsReviewRequest({ repo: "a/b", state: "open" }), false);
    assert.equal(sharedEnvs(), "Postman Beta and Postman Prod");
    assert.deepEqual(enabledEnvironments().map((e) => e.id), ["localhost", "postman_beta", "postman_prod"]);
    assert.equal(deployStageOf({ repo: "acme/deploy-beta" } as never), "beta");
    setTeam({ ...DEFAULT_TEAM, userName: "Sam", reviewChannelId: "C0123ABCD", reviewChannelName: "reviews" });
    assert.match(gistPrompt("awaiting_input", "…"), /between Sam \(USER\)/);
    assert.equal(wantsReviewRequest({ repo: "a/b", state: "open" }), true);
  } finally {
    setTeam(saved);
  }
});

test("a worktree with no config file reads the main checkout's, read-only; its own file or AGENT_DASH_CONFIG wins", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-dash-wt-")));
  const main = join(root, "main");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: main, stdio: "pipe" });
  execFileSync("git", ["init", "-q", main]);
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  git("worktree", "add", "-q", join(root, "wt"));
  const wt = join(root, "wt");
  assert.deepEqual(findConfigFile(wt, ""), { file: join(wt, "agent-dash.config.json"), readOnly: false });
  writeFileSync(join(main, "agent-dash.config.json"), "{}");
  assert.deepEqual(findConfigFile(wt, ""), { file: join(main, "agent-dash.config.json"), readOnly: true });
  assert.deepEqual(findConfigFile(main, ""), { file: join(main, "agent-dash.config.json"), readOnly: false });
  assert.deepEqual(findConfigFile(wt, "/x/c.json"), { file: "/x/c.json", readOnly: false });
  writeFileSync(join(wt, "agent-dash.config.json"), "{}");
  assert.deepEqual(findConfigFile(wt, ""), { file: join(wt, "agent-dash.config.json"), readOnly: false });
});

test("Save is refused on a read-only config file, and the file stays as it was", async () => {
  const ro = join(dir, "ro.json");
  writeFileSync(ro, "{}");
  const s = createServer(async (req, res) => {
    if (!(await handle(req, res, new URL(req.url ?? "/", "http://localhost"), ro, true))) res.writeHead(404).end();
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/settings`;
  try {
    assert.equal((await (await fetch(url)).json()).readOnly, true);
    assert.equal((await fetch(url, { method: "POST", headers: { "X-Agent-Dash": "1" }, body: JSON.stringify({ userName: "X" }) })).status, 409);
    assert.equal(readFileSync(ro, "utf8"), "{}");
  } finally {
    s.close();
  }
});
