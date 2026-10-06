import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// config.ts and db.ts read these at import, so set them before the route module loads.
const dir = mkdtempSync(join(tmpdir(), "agent-dash-plan-"));
process.env.AGENT_DASH_DB = join(dir, "test.db");
process.env.AGENT_DASH_STATUS_DIR = join(dir, "status");
process.env.AGENT_DASH_INBOX_DIR = join(dir, "inbox");
const db = await import("../server/summaries/db.ts");
const { handle } = await import("../server/routes/smoketestPlan.ts");
type Sessions = Parameters<typeof handle>[3]["sessions"];

// A live planning agent: this test's own pid, with an inbox.
mkdirSync(process.env.AGENT_DASH_STATUS_DIR, { recursive: true });
writeFileSync(join(process.env.AGENT_DASH_STATUS_DIR, "plan-live-1.json"), JSON.stringify({ sessionId: "plan-live-1", pid: process.pid, inbox: true, mode: "rpc", state: "awaiting_input", since: new Date().toISOString(), version: 2 }));

let changes = 0;
const server = createServer(async (req, res) => {
  const deps = { sessions: { scan: async () => [] } as unknown as Sessions, context: async () => null, script: "/dash/scripts/sdlc-event.ts", login: async () => "octocat", onChange: () => changes++ };
  if (!(await handle(req, res, new URL(req.url ?? "/", "http://localhost"), deps))) res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const run = async (id: number, body: unknown, headers: Record<string, string> = { "X-Agent-Dash": "1" }) => {
  const res = await fetch(`${base}/api/sdlc-events/run?id=${id}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { code: res.status, body: (await res.json().catch(() => null)) as { error?: string; sessionId?: string } | null };
};

const newPlan = (sessionId: string | null, ticket: string) => db.addSdlcEvent({ eventType: "smoketest_plan", startedAt: new Date().toISOString(), environments: ["postman_beta"], tickets: [ticket], sessionId });

test("Confirm approves the plan version on the page, and sends the run to the live planning agent", async () => {
  const p = newPlan("plan-live-1", "FSDK-80");
  assert.equal((await run(p.id, {}, {})).code, 403);
  assert.match((await run(p.id, {})).body!.error!, /not recorded the plan yet/);

  const v1 = db.recordPlan(p.id, { plan: "1. Create a project", stateChanges: "POST /api/projects on Postman Beta", plannedAt: "2026-10-05T10:00:00.000Z" })!;
  db.recordPlan(p.id, { plan: "1. Create a project\n2. Delete it", stateChanges: "POST and DELETE /api/projects on Postman Beta", plannedAt: "2026-10-05T10:05:00.000Z" });
  const stale = await run(p.id, { plannedAt: v1.plannedAt });
  assert.equal(stale.code, 409);
  assert.match(stale.body!.error!, /plan changed/);
  assert.equal(db.getSdlcEvent(p.id)!.confirmedAt, null);

  const ok = await run(p.id, { plannedAt: "2026-10-05T10:05:00.000Z" });
  assert.equal(ok.code, 201);
  assert.equal(ok.body!.sessionId, "plan-live-1");
  assert.equal(db.getSdlcEvent(p.id)!.confirmedBy, "octocat");
  const execution = db.sdlcEventsByTicket()["FSDK-80"].find((e) => e.eventType === "smoketest_execution")!;
  assert.deepEqual([execution.planId, execution.sessionId, execution.finishedAt], [p.id, "plan-live-1", null]);
  const inbox = join(process.env.AGENT_DASH_INBOX_DIR!, "plan-live-1");
  const message = readFileSync(join(inbox, readdirSync(inbox).find((f) => f.endsWith(".txt"))!), "utf8");
  assert.match(message, /Piper confirmed the smoketest plan of FSDK-80 on Postman Beta/);
  assert.match(message, /and only those:\nPOST and DELETE \/api\/projects on Postman Beta/);
  assert.match(message, new RegExp(`finish --id ${execution.id} `));
  assert.ok(changes > 0);

  // One run at a time per plan.
  assert.match((await run(p.id, { plannedAt: "2026-10-05T10:05:00.000Z" })).body!.error!, /already running/);
});

test("a plan whose agent is gone, on a ticket the dash does not show, stays unconfirmed", async () => {
  const p = newPlan(null, "FSDK-81");
  db.recordPlan(p.id, { plan: "1. x", stateChanges: "y", plannedAt: "2026-10-05T11:00:00.000Z" });
  const res = await run(p.id, { plannedAt: "2026-10-05T11:00:00.000Z", cwd: dir });
  assert.equal(res.code, 404);
  assert.equal(db.getSdlcEvent(p.id)!.confirmedAt, null);
  assert.equal(db.sdlcEventsByTicket()["FSDK-81"].length, 1);
  assert.equal((await run(999_999, {})).code, 404);
});
