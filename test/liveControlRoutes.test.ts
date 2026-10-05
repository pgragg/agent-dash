import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// config.ts reads the folders at import, so set them before the route module loads.
const tmp = mkdtempSync(join(tmpdir(), "agent-dash-routes-"));
for (const d of ["status", "inbox", "conv"]) mkdirSync(join(tmp, d));
process.env.AGENT_DASH_STATUS_DIR = join(tmp, "status");
process.env.AGENT_DASH_INBOX_DIR = join(tmp, "inbox");
process.env.AGENT_DASH_CONVERSATIONS_DIR = join(tmp, "conv");
const { handle } = await import("../server/routes/liveControl.ts");

const server = createServer(async (req, res) => {
  if (!(await handle(req, res, new URL(req.url ?? "/", "http://localhost")))) res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const call = async (path: string, body?: unknown, headers: Record<string, string> = { "X-Agent-Dash": "1" }) => {
  const res = await fetch(base + path, { method: "POST", headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  return { code: res.status, body: (await res.json().catch(() => null)) as { error?: string } | null };
};

/** A live session: this test process's own pid is alive. */
const status = (id: string, over: object = {}) =>
  writeFileSync(join(tmp, "status", `${id}.json`), JSON.stringify({ sessionId: id, pid: process.pid, inbox: true, state: "working", since: new Date().toISOString(), ...over }));
const inbox = (id: string) => readdirSync(join(tmp, "inbox", id));

test("every route needs the header, a real session id, and a live session with an inbox", async () => {
  assert.equal((await call("/api/stop?session=aaaaaaaa", undefined, {})).code, 403);
  assert.equal((await call("/api/stop?session=../../etc")).code, 400);
  assert.equal((await call("/api/stop?session=nosuchsession")).code, 409);
  status("deadsession", { pid: 999_999_999, version: 2 });
  assert.equal((await call("/api/stop?session=deadsession")).code, 409);
});

test("an old extension takes plain replies only; version 2 also takes Steer and Stop", async () => {
  status("oldsession1");
  assert.equal((await call("/api/reply?session=oldsession1", { text: "hi" })).code, 202);
  assert.equal((await call("/api/reply?session=oldsession1", { text: "hi", steer: true })).code, 409);
  assert.equal((await call("/api/stop?session=oldsession1")).code, 409);
  assert.deepEqual(inbox("oldsession1").map((f) => f.split(".").pop()), ["txt"]);

  status("newsession1", { version: 2 });
  assert.equal((await call("/api/reply?session=newsession1", { text: "  " })).code, 400);
  assert.equal((await call("/api/reply?session=newsession1", { text: "go", steer: true })).code, 202);
  assert.equal((await call("/api/stop?session=newsession1")).code, 202);
  assert.deepEqual(inbox("newsession1").map((f) => f.split(".").pop()).sort(), ["abort", "steer"]);
});

test("a dialog is answered once, through the FIFO, only in an rpc session and only for the open dialog", async () => {
  const dialog = { method: "confirm", title: "Allow rm?", since: new Date().toISOString() };
  status("tuisession", { version: 2, mode: "tui", dialog });
  assert.match((await call("/api/dialog?session=tuisession", { confirmed: true })).body?.error ?? "", /iTerm/);

  const id = "rpcsession1";
  status(id, { version: 2, mode: "rpc" });
  assert.equal((await call(`/api/dialog?session=${id}`, { confirmed: true })).code, 409);
  status(id, { version: 2, mode: "rpc", dialog });
  writeFileSync(join(tmp, "conv", `${id}.log`), `${JSON.stringify({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Allow rm?", message: "m" })}\n`);
  const fifo = join(tmp, "conv", `${id}.in`);
  // No reader yet: the write fails at once instead of hanging the server.
  execFileSync("mkfifo", [fifo]);
  assert.equal((await call(`/api/dialog?session=${id}`, { confirmed: true })).code, 409);
  const fd = openSync(fifo, "r+");
  try {
    assert.equal((await call(`/api/dialog?session=${id}`, "{not json")).code, 400);
    assert.equal((await call(`/api/dialog?session=${id}`, { value: "yes" })).code, 400);
    assert.equal((await call(`/api/dialog?session=${id}`, { confirmed: true })).code, 202);
    const buf = Buffer.alloc(200);
    assert.equal(buf.subarray(0, readSync(fd, buf)).toString(), '{"type":"extension_ui_response","id":"d1","confirmed":true}\n');
    // The same request is never answered twice.
    assert.match((await call(`/api/dialog?session=${id}`, { confirmed: true })).body?.error ?? "", /gone/);
  } finally {
    closeSync(fd);
  }
  assert.equal(readFileSync(join(tmp, "conv", `${id}.log`), "utf8").includes("d1"), true);
});

test("Stop cancels an editor dialog through the FIFO in rpc, and says so when it cannot in a terminal", async () => {
  const dialog = { method: "editor", title: "Edit", since: new Date().toISOString() };
  status("tuieditor1", { version: 2, mode: "tui", dialog });
  const tui = await fetch(`${base}/api/stop?session=tuieditor1`, { method: "POST", headers: { "X-Agent-Dash": "1" } });
  assert.equal(tui.status, 202);
  assert.match(((await tui.json()) as { note?: string }).note ?? "", /editor dialog/);

  const id = "rpceditor1";
  status(id, { version: 2, mode: "rpc", dialog });
  writeFileSync(join(tmp, "conv", `${id}.log`), `${JSON.stringify({ type: "extension_ui_request", id: "e1", method: "editor", title: "Edit", prefill: "x" })}\n`);
  const fifo = join(tmp, "conv", `${id}.in`);
  execFileSync("mkfifo", [fifo]);
  const fd = openSync(fifo, "r+");
  try {
    const rpc = await fetch(`${base}/api/stop?session=${id}`, { method: "POST", headers: { "X-Agent-Dash": "1" } });
    assert.deepEqual(await rpc.json(), { ok: true });
    const buf = Buffer.alloc(200);
    assert.equal(buf.subarray(0, readSync(fd, buf)).toString(), '{"type":"extension_ui_response","id":"e1","cancelled":true}\n');
  } finally {
    closeSync(fd);
  }
  assert.deepEqual(inbox(id).map((f) => f.split(".").pop()), ["abort"]);
});
