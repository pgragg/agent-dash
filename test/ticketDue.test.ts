import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";

// A fake Jira that holds one ticket's due date and records each write.
let due: string | null = null;
const writes: unknown[] = [];
const jira = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/rest/api/3/issue/FSDK-99999?fields=duedate") return void res.writeHead(200).end(JSON.stringify({ fields: { duedate: due } }));
    if (req.method === "PUT" && req.url === "/rest/api/3/issue/FSDK-99999") {
      writes.push(JSON.parse(body));
      due = JSON.parse(body).fields.duedate;
      return void res.writeHead(204).end();
    }
    res.writeHead(404).end("{}");
  });
});
await new Promise<void>((r) => jira.listen(0, "127.0.0.1", r));

// config.ts reads the Jira server at import, so set it before the route module loads.
process.env.JIRA_SERVER = `http://127.0.0.1:${(jira.address() as AddressInfo).port}`;
process.env.JIRA_API_TOKEN = "test";
const { handle } = await import("../server/routes/ticket.ts");

const changed: [string, unknown][] = [];
const server = createServer(async (req, res) => {
  if (!(await handle(req, res, new URL(req.url ?? "/", "http://localhost"), (k, patch) => changed.push([k, patch])))) res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => {
  server.close();
  jira.close();
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const call = async (key: string, body: unknown, headers: Record<string, string> = { "X-Agent-Dash": "1" }) => {
  const res = await fetch(`${base}/api/ticket/due?key=${key}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { code: res.status, body: (await res.json().catch(() => null)) as { error?: string; from?: string | null; dueDate?: string } | null };
};

beforeEach(() => {
  due = null;
  writes.length = 0;
  changed.length = 0;
});

test("a due date needs the header, a real key, and real dates", async () => {
  assert.equal((await call("FSDK-99999", { date: "2026-10-30", from: null }, {})).code, 403);
  assert.equal((await call("FSM-1", { date: "2026-10-30", from: null })).code, 400);
  assert.equal((await call("FSDK-99999", { date: "next week", from: null })).code, 400);
  assert.equal((await call("FSDK-99999", { date: "2026-10-30" })).code, 400);
  assert.equal((await call("FSDK-99999", { date: "2026-10-30", from: "soon" })).code, 400);
  assert.deepEqual(writes, []);
});

test("the server sets the due date in Jira, and tells the board", async () => {
  due = "2026-09-22";
  const r = await call("FSDK-99999", { date: "2026-10-30", from: "2026-09-22" });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { key: "FSDK-99999", from: "2026-09-22", dueDate: "2026-10-30" });
  assert.deepEqual(writes, [{ fields: { duedate: "2026-10-30" } }]);
  assert.deepEqual(changed, [["FSDK-99999", { dueDate: "2026-10-30" }]]);
});

test("a first due date works the same way", async () => {
  assert.equal((await call("FSDK-99999", { date: "2026-10-30", from: null })).code, 200);
  assert.equal(due, "2026-10-30");
});

test("a click does not replace a due date that the page did not show", async () => {
  due = "2026-11-15";
  const r = await call("FSDK-99999", { date: "2026-10-30", from: "2026-09-22" });
  assert.equal(r.code, 409);
  assert.match(r.body?.error ?? "", /now due 2026-11-15/);
  assert.deepEqual(writes, []);
  assert.deepEqual(changed, []);
});
