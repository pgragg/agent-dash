import { existsSync, mkdirSync, statSync, watch, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize } from "node:path";
import type { Dashboard, PullRequest, SourceHealth, Ticket } from "../shared/types.ts";
import { actionCandidates, keepWhenDown, toActions } from "./actions.ts";
import { config } from "./config.ts";
import { startConversation } from "./conversations.ts";
import { buildHandoff, stepMessage } from "./handoff.ts";
import { focusItermSession, piCommand, runInNewItermTab } from "./iterm.ts";
import { buildDashboard, buildHistory, otherTicketKeys } from "./model.ts";
import * as liveControl from "./routes/liveControl.ts";
import { fetchMyPrs } from "./sources/github.ts";
import { fetchMyTickets, fetchTickets } from "./sources/jira.ts";
import { SessionIndex, transcriptTurns } from "./sources/sessions.ts";
import { isAlive, readReportedStatuses } from "./sources/status.ts";
import * as summaryDb from "./summaries/db.ts";
import { reconcile, requestSummary } from "./summaries/runner.ts";

const WEB_DIST = new URL("../web/dist/", import.meta.url).pathname;
const EXTENSION_PATH = join(homedir(), ".pi/agent/extensions/agent-dash-status.ts");

/**
 * Keeps the last good answer when a refresh fails, and reports the failure next to it.
 * After the first fetch, a stale value is returned at once and refreshed in the background,
 * because GitHub can take 10 s and the page reloads on every log write.
 */
class Cached<T> {
  value: T;
  health: SourceHealth = { ok: false, error: "not fetched yet" };
  private at = 0;
  private inflight: Promise<void> | null = null;
  private readonly load: () => Promise<T>;

  constructor(initial: T, load: () => Promise<T>) {
    this.value = initial;
    this.load = load;
  }

  async get(force = false): Promise<T> {
    if (force || Date.now() - this.at > config.remoteTtlMs) {
      const first = this.at === 0;
      this.inflight ??= this.load()
        .then((v) => {
          this.value = v;
          this.health = { ok: true, fetchedAt: new Date().toISOString() };
        })
        .catch((err: Error) => {
          this.health = { ok: false, error: err.message, fetchedAt: this.health.fetchedAt };
        })
        .finally(() => {
          this.at = Date.now();
          this.inflight = null;
          if (!first) broadcast();
        });
      if (first || force) await this.inflight;
    }
    return this.value;
  }
}

const sessions = new SessionIndex(config.sessionsDir, config.ticketPattern);
const myTickets = new Cached<Ticket[]>([], fetchMyTickets);
const prs = new Cached<PullRequest[]>([], () => fetchMyPrs(config.recentDays, config.ticketPattern));
const others = new Map<string, Ticket>();
let othersHealth: SourceHealth = { ok: true };

async function dashboard(force: boolean) {
  const now = Date.now();
  let sessionsHealth: SourceHealth = { ok: true, fetchedAt: new Date(now).toISOString() };
  const [parsed, reported, mine, pulls] = await Promise.all([
    sessions.scan().catch((err: Error) => {
      sessionsHealth = { ok: false, error: err.message };
      return [];
    }),
    readReportedStatuses(config.statusDir),
    myTickets.get(force),
    prs.get(force),
  ]);

  // Tickets outside my open list are looked up once and kept; their summaries rarely change.
  const missing = otherTicketKeys(parsed, pulls, new Set(mine.map((t) => t.key)), now, config.recentDays).filter((k) => force || !others.has(k));
  if (missing.length) {
    try {
      for (const t of await fetchTickets(missing)) others.set(t.key, t);
      othersHealth = { ok: true };
    } catch (err) {
      othersHealth = { ok: false, error: (err as Error).message };
    }
  }

  reconcile();
  const summaries: Dashboard["summaries"] = {};
  // pid and work dir stay on the server.
  const pub = ({ pid: _pid, workDir: _dir, ...rest }: summaryDb.SummaryRecord) => rest;
  for (const [key, { latest, lastDone }] of summaryDb.summariesByTicket()) {
    summaries[key] = { latest: pub(latest), lastDone: lastDone ? pub(lastDone) : null };
  }

  const jira = !myTickets.health.ok ? myTickets.health : othersHealth.ok ? myTickets.health : othersHealth;
  const d = buildDashboard({
    sessions: parsed,
    reported,
    myTickets: mine,
    otherTickets: [...others.values()],
    prs: pulls,
    now,
    recentDays: config.recentDays,
    sources: { jira, github: prs.health, sessions: sessionsHealth },
    extensionInstalled: existsSync(EXTENSION_PATH),
    summaries,
    notes: summaryDb.notesByTicket(),
    threads: summaryDb.currentThreadStatuses(),
    jiraServer: config.jira.server,
  });
  const candidates = actionCandidates(d);
  d.actions = toActions(candidates, summaryDb.syncActions(candidates, keepWhenDown(d.sources), new Date(now)), d);
  return d;
}

// ---- live updates -------------------------------------------------------------------

const clients = new Set<ServerResponse>();
let pending: NodeJS.Timeout | null = null;

function broadcast(): void {
  if (pending) return;
  // pi writes a log line per message; one refresh per burst is enough.
  pending = setTimeout(() => {
    pending = null;
    for (const res of clients) res.write("event: change\ndata: {}\n\n");
  }, 750);
}

mkdirSync(config.statusDir, { recursive: true });
watch(config.sessionsDir, { recursive: true }, broadcast);
watch(config.statusDir, broadcast);
// A summary run saves into SQLite from its own process; WAL writes touch agent-dash.db-wal.
watch(dirname(summaryDb.DB_PATH), (_e, file) => {
  if (file?.startsWith(basename(summaryDb.DB_PATH))) broadcast();
});
// Time alone changes a status: a pid dies, or a wait crosses a threshold.
setInterval(broadcast, 30_000).unref();

// ---- http ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > max) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = await readFile(join(WEB_DIST, rel));
    res.writeHead(200, { "Content-Type": TYPES[extname(rel)] ?? "application/octet-stream" }).end(body);
  } catch {
    const index = await readFile(join(WEB_DIST, "index.html")).catch(() => null);
    if (index) res.writeHead(200, { "Content-Type": "text/html" }).end(index);
    else res.writeHead(404).end("web/dist is missing. Run `pnpm build`, or use `pnpm dev`.");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (await liveControl.handle(req, res, url)) return;
    if (url.pathname === "/api/dashboard") {
      const body = JSON.stringify(await dashboard(url.searchParams.has("refresh")));
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(body);
    } else if (url.pathname === "/api/summaries" && req.method === "POST") {
      // Same CSRF guard as /api/focus: this endpoint starts a paid model run.
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const key = url.searchParams.get("ticket") ?? "";
      const d = await dashboard(false);
      const group = [...d.myTickets, ...d.otherTickets].find((g) => g.ticket.key === key);
      if (!group) return void res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `unknown ticket ${key}` }));
      const rec = await requestSummary(group, { force: url.searchParams.has("force"), onChange: broadcast });
      broadcast();
      res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ id: rec.id, status: rec.status }));
    } else if (url.pathname === "/api/notes" && (req.method === "POST" || req.method === "DELETE")) {
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      if (req.method === "DELETE") {
        const ok = summaryDb.deleteNote(Number(url.searchParams.get("id")));
        broadcast();
        return json(ok ? 200 : 404, ok ? { ok } : { error: "no such note" });
      }
      const ticket = url.searchParams.get("ticket") ?? "";
      // Only a real ticket key, so a typo cannot file notes under a key that never shows.
      if (!new RegExp(`^${config.ticketPattern.source}$`).test(ticket)) return json(400, { error: `not a ticket key: ${ticket}` });
      const { body } = JSON.parse((await readBody(req, 64_000)) || "{}") as { body?: string };
      if (!body?.trim()) return json(400, { error: "empty note" });
      const note = summaryDb.addNote(ticket, body.trim());
      broadcast();
      json(201, note);
    } else if (url.pathname === "/api/agents/context" || (url.pathname === "/api/agents" && req.method === "POST")) {
      // A new pi agent that starts with the ticket's context. The context route is a preview.
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const key = url.searchParams.get("ticket") ?? "";
      const d = await dashboard(false);
      const group = [...d.myTickets, ...d.otherTickets].find((g) => g.ticket.key === key);
      if (!group) return json(404, { error: `unknown ticket ${key}` });
      const context = buildHandoff({ group, notes: d.notes[key] ?? [], summary: d.summaries[key], now: new Date() });
      if (url.pathname === "/api/agents/context") return void res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" }).end(context);

      const body = JSON.parse((await readBody(req, 64_000)) || "{}") as { message?: string; step?: number; cwd?: string };
      const cwd = body.cwd ?? homedir();
      // A step is read from the database, so the button starts the step that the page shows.
      const step = body.step === undefined ? null : summaryDb.getStep(Number(body.step));
      if (body.step !== undefined && step?.ticket !== key) return json(404, { error: "no such next step on this ticket" });
      const message = step ? stepMessage(key, step.body) : body.message;
      if (!message?.trim()) return json(400, { error: "write the first message" });
      const dir = cwd.replace(/^~(?=\/|$)/, homedir());
      if (!dir.startsWith("/") || !existsSync(dir) || !statSync(dir).isDirectory()) return json(400, { error: `not a folder: ${cwd}` });

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = join(config.handoffDir, `${key}-${stamp}`);
      mkdirSync(config.handoffDir, { recursive: true });
      writeFileSync(`${base}.md`, context);
      // A leading "-" would read as a pi option; the space keeps it a message.
      writeFileSync(`${base}.txt`, message.trim().startsWith("-") ? ` ${message.trim()}` : message.trim());
      // The name carries the key, so the new run links to the ticket at once.
      const name = `${key}: ${(step?.body.replace(/[*`]/g, "") ?? message).trim().split("\n")[0].slice(0, 60)}`;
      const command = piCommand(dir, name, `${base}.md`, `${base}.txt`);
      const out = await runInNewItermTab(command);
      if (out.result !== "ok") return json(500, { error: out.result === "not_authorized" ? "Allow it in System Settings → Privacy & Security → Automation → iTerm2." : (out.detail ?? "could not open iTerm") });
      json(201, { ok: true, contextFile: `${base}.md` });
    } else if (url.pathname === "/api/conversations" && req.method === "POST") {
      // A plain pi with no ticket and no context file, run headless so the page is its UI.
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const body = JSON.parse((await readBody(req, 64_000)) || "{}") as { message?: string; cwd?: string };
      if (!body.message?.trim()) return json(400, { error: "write the first message" });
      const dir = (body.cwd?.trim() || "~").replace(/^~(?=\/|$)/, homedir());
      if (!dir.startsWith("/") || !existsSync(dir) || !statSync(dir).isDirectory()) return json(400, { error: `not a folder: ${body.cwd}` });
      json(201, { sessionId: startConversation(dir, body.message.trim()) });
    } else if (url.pathname === "/api/conversations/end" && req.method === "POST") {
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const status = (await readReportedStatuses(config.statusDir)).get(url.searchParams.get("session") ?? "");
      // Only a headless run: a terminal pi is closed from its own tab.
      if (status?.mode !== "rpc" || !isAlive(status.pid)) return void res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no live conversation to end" }));
      process.kill(status.pid, "SIGTERM");
      res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (url.pathname === "/api/threads" && req.method === "POST") {
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const ticket = url.searchParams.get("ticket") ?? "";
      const session = url.searchParams.get("session") ?? "";
      if (!new RegExp(`^${config.ticketPattern.source}$`).test(ticket)) return json(400, { error: `not a ticket key: ${ticket}` });
      if (!/^[\w-]{8,64}$/.test(session)) return json(400, { error: "not a session id" });
      const { status, reason } = JSON.parse((await readBody(req, 16_000)) || "{}") as { status?: string; reason?: string };
      if (status !== "resolved" && status !== "relevant") return json(400, { error: "status must be resolved or relevant" });
      const change = summaryDb.setThreadStatus(ticket, session, status, reason?.trim() || null);
      broadcast();
      json(201, change);
    } else if (url.pathname === "/api/focus" && req.method === "POST") {
      // A custom header forces a CORS preflight, which this server never answers,
      // so another web page cannot make the browser call this endpoint.
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const sessionId = url.searchParams.get("session") ?? "";
      // Look the tab up from the status file; never take a tab id from the request.
      const tab = (await readReportedStatuses(config.statusDir)).get(sessionId)?.itermSessionId;
      if (!tab) return void res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ result: "missing" }));
      const out = await focusItermSession(tab);
      const code = out.result === "ok" ? 200 : out.result === "missing" ? 404 : 500;
      res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(out));
    } else if (url.pathname === "/api/history") {
      const [parsed, reported, pulls] = await Promise.all([sessions.scan(), readReportedStatuses(config.statusDir), prs.get(false)]);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(buildHistory(parsed, reported, pulls, Date.now())));
    } else if (url.pathname === "/api/transcript") {
      const sessionId = url.searchParams.get("session") ?? "";
      const file = sessions.fileFor(sessionId) ?? ((await sessions.scan()) && sessions.fileFor(sessionId));
      if (!file) return void res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no such session" }));
      const body = { sessionId, turns: transcriptTurns(await readFile(file, "utf8")) };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    } else if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write("retry: 3000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else {
      await serveStatic(url.pathname, res);
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end((err as Error).stack);
  }
});

// Loopback only: the page shows prompts and replies from every session.
server.listen(config.port, "127.0.0.1", () => {
  console.log(`agent-dash on http://127.0.0.1:${config.port}`);
});
