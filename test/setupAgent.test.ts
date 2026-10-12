import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { headlessCommand, installPiExtension } from "../server/agent.ts";
import { readSettingsFile, saveSettingsPatch } from "../server/config.ts";
import { handle, SAVE_SCRIPT, setupMessage } from "../server/routes/setup.ts";
import { SessionIndex } from "../server/sources/sessions.ts";
import { DEFAULT_SETTINGS, SETTING_FIELDS, validateSettings } from "../shared/settings.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-dash-setup-"));

test("every setting has an example that passes its own check, and a way to find it", () => {
  for (const f of SETTING_FIELDS) {
    assert.ok(f.example.trim(), `${f.key} has no example`);
    assert.ok(f.find.trim(), `${f.key} has no way to find it`);
    assert.deepEqual(validateSettings({ [f.key]: f.example }).errors, {}, `${f.key}'s example is not valid`);
  }
});

test("a settings patch keeps the other keys, and writes nothing when one value or key is bad", () => {
  const file = join(dir, "patch.json");
  writeFileSync(file, JSON.stringify({ userName: "Sam", ticketProjects: ["ABC"] }));
  assert.deepEqual(saveSettingsPatch({ jiraLogin: "sam@x.com" }, file).errors, {});
  const saved = readSettingsFile(file).settings;
  assert.equal(saved.userName, "Sam");
  assert.equal(saved.jiraLogin, "sam@x.com");
  assert.deepEqual(saved.ticketProjects, ["ABC"]);

  const bad = saveSettingsPatch({ userName: "Kim", ticketProjects: ["lower"], nope: 1 }, file);
  assert.deepEqual(Object.keys(bad.errors).sort(), ["nope", "ticketProjects"]);
  assert.equal(readSettingsFile(file).settings.userName, "Sam");
});

test("save-settings.ts saves a patch from stdin, and refuses a bad one with its reason", () => {
  const file = join(dir, "script.json");
  const run = (input: string) => execFileSync(process.execPath, [SAVE_SCRIPT], { input, env: { ...process.env, AGENT_DASH_CONFIG: file }, encoding: "utf8", stdio: "pipe" });
  assert.match(run(JSON.stringify({ userName: "Sam", ticketProjects: ["ABC", "AD"] })), /Saved/);
  assert.deepEqual(readSettingsFile(file).settings.ticketProjects, ["ABC", "AD"]);
  assert.throws(() => run(JSON.stringify({ port: 0 })), (err: { status: number; stderr: string }) => err.status === 1 && /port: must be a whole number/.test(err.stderr));
  assert.equal(readSettingsFile(file).settings.port, 7777);
});

test("the setup message gives each setting its description, example, way to find it and value, but not the agent", () => {
  const msg = setupMessage({ agent: "claude", file: "/x/agent-dash.config.json", current: { ...DEFAULT_SETTINGS, userName: "Sam" }, missing: ["your Jira login"], script: SAVE_SCRIPT, url: "http://127.0.0.1:7777" });
  for (const f of SETTING_FIELDS.filter((f) => f.key !== "agent")) {
    const line = msg.split("\n").find((l) => l.startsWith(`- \`${f.key}\` `));
    assert.ok(line, `no line for ${f.key}`);
    assert.ok(line.includes(f.help) && line.includes(f.example) && line.includes(f.find), f.key);
  }
  assert.ok(!msg.includes("- `agent` "));
  assert.match(msg, /- `userName` .* Now: `Sam`\./);
  assert.match(msg, /- `jiraServer` .* Now: `https:\/\/postmanlabs.atlassian.net` \(the default\)\./);
  assert.match(msg, /picked Claude Code/);
  assert.match(msg, /Start with what is still missing: your Jira login\./);
  assert.ok(msg.includes(`node ${SAVE_SCRIPT} < that-file.json`));
});

test("a followed session in another agent's folder shows in the scan", async () => {
  const pi = join(dir, "pi-sessions");
  const claude = join(dir, "claude-projects");
  mkdirSync(join(pi, "--x--"), { recursive: true });
  mkdirSync(join(claude, "-x"), { recursive: true });
  const id = "11111111-2222-3333-4444-555555555555";
  const index = new SessionIndex(pi, /(?!)/g);
  index.follow(claude, id);
  assert.equal((await index.scan()).length, 0);
  const line = (o: object) => JSON.stringify({ sessionId: id, cwd: "/x", timestamp: "2026-10-06T10:00:00Z", ...o });
  writeFileSync(join(claude, "-x", `${id}.jsonl`), [line({ type: "user", uuid: "a", message: { role: "user", content: "Set up agent-dash" } })].join("\n"));
  const found = await index.scan();
  assert.deepEqual(found.map((s) => [s.sessionId, s.agent]), [[id, "claude"]]);
  assert.equal(index.fileFor(id), join(claude, "-x", `${id}.jsonl`));
});

test("a headless Claude Code can run some tools without a dialog", () => {
  assert.deepEqual(headlessCommand("claude", "s", { allowedTools: ["Read", "Grep"] }).args.slice(-2), ["--allowedTools", "Read,Grep"]);
  assert.ok(!headlessCommand("claude", "s", {}).args.includes("--allowedTools"));
});

test("a headless Claude Code runs in the configured permission mode", () => {
  const { args } = headlessCommand("claude", "s", { permissionMode: "auto" });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "auto");
  assert.ok(!headlessCommand("claude", "s", {}).args.includes("--permission-mode"));
});

test("the pi extension links once, and does not replace a file that is not its link", () => {
  const target = join(dir, "ext", "agent-dash-status.ts");
  assert.match(installPiExtension(false, target), /^Installed/);
  assert.match(readlinkSync(target), /extension\/agent-dash-status\.ts$/);
  assert.match(installPiExtension(false, target), /^Already installed/);
  const other = join(dir, "ext2", "agent-dash-status.ts");
  mkdirSync(join(dir, "ext2"));
  writeFileSync(other, "// mine");
  assert.throws(() => installPiExtension(false, other), /not agent-dash's symlink/);
  assert.equal(readFileSync(other, "utf8"), "// mine");
});

const server = createServer(async (req, res) => {
  if (!(await handle(req, res, new URL(req.url ?? "/", "http://localhost"), { follow: () => {} }))) res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/setup`;

test("starting the setup agent needs the header and a known agent", async () => {
  assert.equal((await fetch(base, { method: "POST", body: JSON.stringify({ agent: "pi" }) })).status, 403);
  const res = await fetch(base, { method: "POST", headers: { "X-Agent-Dash": "1" }, body: JSON.stringify({ agent: "codex" }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /pi, claude or opencode/);
});
