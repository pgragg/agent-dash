import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";

// A fake Jira with one ticket: its status, due date, and the transitions it offers from there.
let status = "To Do";
const BACKLOG = [
  { id: "11", name: "Prioritized", to: { name: "To Do", statusCategory: { key: "new" } }, fields: { priority: { schema: { type: "priority" } } } },
  { id: "12", name: "Backlog", to: { name: "Backlog", statusCategory: { key: "new" } } },
];
let due: string | null = null;
const writes: { method: string; url: string; body: any }[] = [];
const TRANSITIONS = [
  { id: "21", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } }, fields: { customfield_11930: { schema: { type: "date" } }, priority: { schema: { type: "priority" } } } },
  { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } }, fields: { duedate: { schema: { type: "date" } } } },
];
const jira = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/rest/api/3/issue/FSDK-99999/transitions?expand=transitions.fields") return void res.writeHead(200).end(JSON.stringify({ transitions: status === "Backlog" ? BACKLOG : TRANSITIONS }));
    if (req.method === "GET" && url.startsWith("/rest/api/3/issue/FSDK-99999?fields=")) {
      return void res.writeHead(200).end(JSON.stringify({ fields: { status: { name: status }, duedate: due, customfield_11930: null, priority: { id: "3", name: "P2" } } }));
    }
    if (req.method === "PUT" || req.method === "POST") {
      const b = JSON.parse(body);
      writes.push({ method: req.method, url, body: b });
      const t = [...BACKLOG, ...TRANSITIONS].find((x) => x.id === b.transition?.id);
      if (t) status = t.to.name;
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
const { defaultDueDate } = await import("../shared/jiraVerbs.ts");

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
  const res = await fetch(`${base}/api/ticket/move?key=${key}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { code: res.status, body: (await res.json().catch(() => null)) as { error?: string; to?: string; dueDate?: string | null } | null };
};

beforeEach(() => {
  status = "To Do";
  due = null;
  writes.length = 0;
  changed.length = 0;
});

test("a move needs the header, a Jira key, a transition id, and the status the page showed", async () => {
  assert.equal((await call("FSDK-99999", { to: "In Progress", from: "To Do" }, {})).code, 403);
  assert.equal((await call("AD-1", { to: "In Progress", from: "To Do" })).code, 400);
  assert.equal((await call("FSDK-99999", { to: "", from: "To Do" })).code, 400);
  assert.equal((await call("FSDK-99999", { to: "In Progress" })).code, 400);
  assert.deepEqual(writes, []);
});

test("a move to In Progress sets the default due date first, then sends the screen fields", async () => {
  const r = await call("FSDK-99999", { to: "In Progress", from: "To Do" });
  assert.equal(r.code, 200);
  const dueDate = defaultDueDate(new Date());
  const today = new Date().toLocaleDateString("en-CA");
  assert.deepEqual(writes, [
    { method: "PUT", url: "/rest/api/3/issue/FSDK-99999", body: { fields: { duedate: dueDate } } },
    { method: "POST", url: "/rest/api/3/issue/FSDK-99999/transitions", body: { transition: { id: "21" }, fields: { customfield_11930: today, priority: { id: "3" } } } },
  ]);
  assert.deepEqual(changed, [["FSDK-99999", { status: "In Progress", statusCategory: "indeterminate", dueDate }]]);
});

test("a move keeps a due date the ticket has", async () => {
  due = "2026-11-01";
  assert.equal((await call("FSDK-99999", { to: "Done", from: "To Do" })).code, 200);
  assert.deepEqual(writes, [{ method: "POST", url: "/rest/api/3/issue/FSDK-99999/transitions", body: { transition: { id: "31" }, fields: { duedate: "2026-11-01" } } }]);
});

test("a click does not move a ticket whose status changed, or along a transition Jira does not offer", async () => {
  status = "In Review";
  const r = await call("FSDK-99999", { to: "In Progress", from: "To Do" });
  assert.equal(r.code, 409);
  assert.match(r.body?.error ?? "", /now "In Review"/);
  status = "To Do";
  assert.equal((await call("FSDK-99999", { to: "Blocked", from: "To Do" })).code, 409);
  assert.deepEqual(writes, []);
  assert.deepEqual(changed, []);
});

test("Backlog walks through To Do to In Progress, with the due date set first", async () => {
  status = "Backlog";
  const r = await call("FSDK-99999", { to: "In Progress", from: "Backlog" });
  assert.equal(r.code, 200);
  assert.deepEqual(
    writes.map((w) => [w.method, w.body.transition?.id ?? w.body.fields.duedate]),
    [
      ["PUT", defaultDueDate(new Date())],
      ["POST", "11"],
      ["POST", "21"],
    ],
  );
  assert.equal(status, "In Progress");
});
