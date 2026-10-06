import { existsSync, mkdirSync, statSync, watch, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize } from "node:path";
import type { Dashboard, PullRequest, SourceHealth, Ticket } from "../shared/types.ts";
import { config } from "./config.ts";
import { startConversation } from "./conversations.ts";
import { recordExit, wroteRecently } from "./exits.ts";
import { focusItermSession, piCommand, runInNewItermTab } from "./iterm.ts";
import { buildDashboard, buildHistory, otherTicketKeys } from "./model.ts";
import * as exitRoutes from "./routes/exits.ts";
import { agentMessage, agentName, buildHandoff, stepMessage } from "./handoff.ts";
import * as resumeRoute from "./routes/resume.ts";
import * as liveControl from "./routes/liveControl.ts";
import * as prRoute from "./routes/pr.ts";
import * as loginRoute from "./routes/login.ts";
import * as slackRoute from "./routes/slack.ts";
import * as ticketRoute from "./routes/ticket.ts";
import * as diagramRoute from "./routes/diagrams.ts";
import * as sdlcRoute from "./routes/sdlc.ts";
import * as smoketestPlanRoute from "./routes/smoketestPlan.ts";
import * as reviewRoute from "./routes/reviewRequests.ts";
import * as lanesRoute from "./routes/lanes.ts";
import * as worktreesRoute from "./routes/worktrees.ts";
import { confirmDeployMessage, deployStageOf, parseEnvironment, planMessage } from "../shared/sdlc.ts";
import { requestConversationSummaries, summariesFor } from "./conversationSummaries.ts";
import { syncDiagrams } from "./diagramSync.ts";
import { sweep as sweepParks } from "./park.ts";
import { fetchMyPrs, type PullWithFeedback } from "./sources/github.ts";
import { toAddressCount } from "../shared/feedback.ts";
import { fetchMyTickets, fetchTickets } from "./sources/jira.ts";
import { isLocalKey, readLocalTickets } from "./sources/localTickets.ts";
import { SessionIndex, transcriptTurns } from "./sources/sessions.ts";
import { isAlive, readReportedStatuses } from "./sources/status.ts";
import * as summaryDb from "./summaries/db.ts";
import { reconcile, redraftAfterNewEvents, requestSummary } from "./summaries/runner.ts";

const WEB_DIST = new URL("../web/dist/", import.meta.url).pathname;
/** Agents record smoketests and deploys with this script, into this dash's database. */
const SDLC_SCRIPT = new URL("../scripts/sdlc-event.ts", import.meta.url).pathname;
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
const prs = new Cached<PullWithFeedback[]>([], () => fetchMyPrs(config.recentDays, config.ticketPattern));
const others = new Map<string, Ticket>();
let othersHealth: SourceHealth = { ok: true };

/** Counted on each build, so a feedback entry marked addressed on the panel counts at once. */
function withToAddress({ feedback, ...pr }: PullWithFeedback): PullRequest {
  if (!feedback) return pr;
  const ref = `${pr.repo}/${pr.number}`.toLowerCase();
  return { ...pr, toAddress: toAddressCount({ ...feedback, addressed: summaryDb.addressedKeys(ref) }) };
}

async function dashboard(force: boolean) {
  const now = Date.now();
  let sessionsHealth: SourceHealth = { ok: true, fetchedAt: new Date(now).toISOString() };
  const [scanned, reported, jiraMine, rawPulls] = await Promise.all([
    sessions.scan().catch((err: Error) => {
      sessionsHealth = { ok: false, error: err.message };
      return [];
    }),
    readReportedStatuses(config.statusDir),
    myTickets.get(force),
    prs.get(force),
  ]);

  // agent-dash's own tickets are local files, so they are read again on each build and never asked of Jira.
  const local = new Map(readLocalTickets(config.localTicketsDir, config.port).map((t) => [t.key, t]));
  // Keys match in any case, so a name such as /tmp/ad-7791.log reads as a key. With no file, it is not a ticket.
  const real = (k: string) => !isLocalKey(k) || local.has(k);
  const parsed = scanned.map((s) => (s.tickets.every(real) ? s : { ...s, tickets: s.tickets.filter(real) }));
  const pulls = rawPulls.map(withToAddress).map((p) => (p.tickets.every(real) ? p : { ...p, tickets: p.tickets.filter(real) }));
  const mine = [...jiraMine, ...[...local.values()].filter((t) => t.statusCategory !== "done")];
  const otherKeys = otherTicketKeys(parsed, pulls, new Set(mine.map((t) => t.key)), now, config.recentDays);
  const otherLocal = otherKeys.flatMap((k) => local.get(k) ?? []);
  // Tickets outside my open list are looked up once and kept; their summaries rarely change.
  const missing = otherKeys.filter((k) => !isLocalKey(k) && (force || !others.has(k)));
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
    otherTickets: [...others.values(), ...otherLocal],
    prs: pulls,
    now,
    recentDays: config.recentDays,
    sources: { jira, github: prs.health, sessions: sessionsHealth },
    extensionInstalled: existsSync(EXTENSION_PATH),
    summaries,
    notes: summaryDb.notesByTicket(),
    snoozedUntil: summaryDb.snoozedUntilByTicket(),
    starred: summaryDb.starredTickets(),
    threads: summaryDb.currentThreadStatuses(),
    parked: new Set(summaryDb.activeParked().map((p) => p.sessionId)),
    jiraServer: config.jira.server,
  });

  // A recent run can take its ticket from its PR; old logs cannot.
  const runTicket = new Map<string, string>();
  for (const g of [...d.myTickets, ...d.otherTickets]) for (const r of g.runs) if (r.tickets[0]) runTicket.set(r.sessionId, r.tickets[0]);
  await syncDiagrams(parsed, (s) => runTicket.get(s.sessionId) ?? s.tickets[0] ?? null, new Date(now));
  d.diagrams = summaryDb.listDiagrams();
  d.sdlcEvents = summaryDb.sdlcEventsByTicket();
  d.reviewDrafts = summaryDb.reviewDrafts();
  d.reviewRequests = summaryDb.reviewRequestsByPr();
  d.lanes = await lanesRoute.lanesByTicket();
  redraftAfterNewEvents([...d.myTickets, ...d.otherTickets], broadcast);
  // Each live agent card opens on its summary, so draft it before Piper looks.
  const boardRuns = [...d.myTickets, ...d.otherTickets].flatMap((g) => g.runs).concat(d.unlinkedRuns);
  requestConversationSummaries(boardRuns.filter((r) => r.status !== "finished"), (id) => sessions.fileFor(id), broadcast);
  d.conversationSummaries = summariesFor(boardRuns);
  const done = new Set([...d.myTickets, ...d.otherTickets].filter((g) => g.ticket.statusCategory === "done").map((g) => g.ticket.key));
  const laneSessions = new Set(Object.values(d.lanes).flatMap((ls) => ls.flatMap((l) => (l.sessionId && l.state !== "landed" ? [l.sessionId] : []))));
  const runs = [...new Map(boardRuns.map((r) => [r.sessionId, r])).values()];
  if (sweepParks({ runs, summaries: d.conversationSummaries, done, threads: summaryDb.currentThreadStatuses(), laneSessions, now }, reported)) broadcast();
  const keepFrom = new Date(now - config.recentDays * 86_400_000).toISOString();
  d.parked = summaryDb.activeParked().filter((p) => p.parkedAt >= keepFrom);
  return d;
}

/** Show a due date the dash just set at once, without a new Jira search. */
function onDueDate(key: string, date: string): void {
  for (const t of [...myTickets.value, ...others.values()]) if (t.key === key) t.dueDate = date;
  broadcast();
}

/** What a new agent on the ticket starts with, as the ticket page's Start agent gives it. */
async function ticketContext(key: string): Promise<string | null> {
  const d = await dashboard(false);
  const group = [...d.myTickets, ...d.otherTickets].find((g) => g.ticket.key === key);
  return group ? buildHandoff({ group, notes: d.notes[key] ?? [], summary: d.summaries[key], events: d.sdlcEvents[key] ?? [], parked: d.parked.filter((p) => p.ticket === key), now: new Date() }) : null;
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
let redraftLoad: Promise<unknown> | null = null;
// A summary run saves into SQLite from its own process; WAL writes touch agent-dash.db-wal.
watch(dirname(summaryDb.DB_PATH), (_e, file) => {
  if (!file?.startsWith(basename(summaryDb.DB_PATH))) return;
  if (!wroteRecently()) broadcast();
  // An agent records an SDLC event from its own process; draft its next steps without waiting for the page.
  if (!redraftLoad && summaryDb.hasNewEventTickets()) redraftLoad = dashboard(false).catch(() => {}).finally(() => (redraftLoad = null));
});
// Time alone changes a status: a pid dies, or a wait crosses a threshold.
setInterval(broadcast, 30_000).unref();

// ---- http ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > max) {
        reject(new Error("request body too large"));
        req.destroy();
      }
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
    if (await exitRoutes.handle(req, res, url)) return;
    if (await resumeRoute.handle(req, res, url, sessions)) return;
    if (await liveControl.handle(req, res, url)) return;
    if (await prRoute.handle(req, res, url, broadcast)) return;
    if (await ticketRoute.handle(req, res, url, onDueDate)) return;
    if (await diagramRoute.handle(req, res, url, sessions, broadcast)) return;
    if (await smoketestPlanRoute.handle(req, res, url, { sessions, context: ticketContext, script: SDLC_SCRIPT, onChange: broadcast })) return;
    if (await sdlcRoute.handle(req, res, url, broadcast)) return;
    // The dashboard's PRs carry the tickets that cross-linking gave them.
    if (await reviewRoute.handle(req, res, url, { prs: async () => (await dashboard(false)).prs, onChange: broadcast })) return;
    if (await lanesRoute.handle(req, res, url, { context: ticketContext, onChange: broadcast })) return;
    if (await worktreesRoute.handle(req, res, url, broadcast)) return;
    if (await loginRoute.handle(req, res, url)) return;
    if (await slackRoute.handle(req, res, url)) return;
    if (url.pathname === "/api/dashboard") {
      const body = JSON.stringify(await dashboard(url.searchParams.has("refresh")));
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(body);
    } else if (url.pathname === "/api/conversation-summaries" && req.method === "POST") {
      // A finished run's summary, drafted when its page opens. It starts a paid model run, so the guard.
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const id = url.searchParams.get("session") ?? "";
      const d = await dashboard(false);
      const r = [...d.myTickets, ...d.otherTickets].flatMap((g) => g.runs).concat(d.unlinkedRuns).find((x) => x.sessionId === id);
      if (!r) return void res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no such run on the board" }));
      const started = requestConversationSummaries([r], (s) => sessions.fileFor(s), broadcast);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ started }));
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
    } else if (url.pathname === "/api/snooze" && req.method === "POST") {
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const ticket = url.searchParams.get("ticket") ?? "";
      if (!new RegExp(`^${config.ticketPattern.source}$`).test(ticket)) return json(400, { error: `not a ticket key: ${ticket}` });
      const { until } = JSON.parse((await readBody(req, 4_000)) || "{}") as { until?: string | null };
      const at = until == null ? null : new Date(until);
      if (at && !(at.getTime() > Date.now())) return json(400, { error: "pick a time in the future" });
      summaryDb.setSnoozedUntil(ticket, at);
      broadcast();
      json(200, { ok: true, snoozedUntil: at?.toISOString() ?? null });
    } else if (url.pathname === "/api/star" && req.method === "POST") {
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const ticket = url.searchParams.get("ticket") ?? "";
      if (!new RegExp(`^${config.ticketPattern.source}$`).test(ticket)) return json(400, { error: `not a ticket key: ${ticket}` });
      const { starred } = JSON.parse((await readBody(req, 4_000)) || "{}") as { starred?: boolean };
      summaryDb.setStarred(ticket, starred === true);
      broadcast();
      json(200, { ok: true, starred: starred === true });
    } else if (url.pathname === "/api/agents/context" || (url.pathname === "/api/agents" && req.method === "POST")) {
      // A new pi agent that starts with the ticket's context. The context route is a preview.
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const key = url.searchParams.get("ticket") ?? "";
      const d = await dashboard(false);
      const group = [...d.myTickets, ...d.otherTickets].find((g) => g.ticket.key === key);
      if (!group) return json(404, { error: `unknown ticket ${key}` });
      const context = buildHandoff({ group, notes: d.notes[key] ?? [], summary: d.summaries[key], events: d.sdlcEvents[key] ?? [], parked: d.parked.filter((p) => p.ticket === key), now: new Date() });
      if (url.pathname === "/api/agents/context") return void res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" }).end(context);

      const body = JSON.parse((await readBody(req, 64_000)) || "{}") as { message?: string; step?: number; cwd?: string; terminal?: boolean; sdlc?: { kind?: string; env?: string; stage?: string }; lanes?: unknown; laneMode?: unknown; base?: unknown };
      const cwd = body.cwd ?? homedir();
      // A step is read from the database, so the button starts the step that the page shows.
      const step = body.step === undefined ? null : summaryDb.getStep(Number(body.step));
      if (body.step !== undefined && step?.ticket !== key) return json(404, { error: "no such next step on this ticket" });
      // An SDLC verb's message is written here, because it names this server's script path.
      const env = body.sdlc?.kind === "smoketest_plan" ? parseEnvironment(body.sdlc.env ?? "") : null;
      const stage = body.sdlc?.kind === "confirm_deploy" && (body.sdlc.stage === "beta" || body.sdlc.stage === "prod") ? body.sdlc.stage : null;
      if (body.sdlc && !env && !stage) return json(400, { error: "unknown SDLC verb" });
      const dir = cwd.replace(/^~(?=\/|$)/, homedir());
      if (!dir.startsWith("/") || !existsSync(dir) || !statSync(dir).isDirectory()) return json(400, { error: `not a folder: ${cwd}` });
      if (body.lanes !== undefined) {
        // Lanes are headless: each one is a row on the ticket page, and iTerm would open N tabs.
        const out = await lanesRoute.startLanes({ key, context, cwd: dir, lanes: body.lanes, mode: body.laneMode, base: body.base, brief: body.message });
        if (out.status === 201) broadcast();
        return json(out.status, out.body);
      }
      if (!step && !body.sdlc && !body.message?.trim()) return json(400, { error: "write the first message" });
      // Picked here, so a smoketest plan's event can link to its agent before pi starts.
      const sessionId = randomUUID();
      // Saved before pi starts, so the stage is yellow from the click.
      const running = env && !step ? summaryDb.addSdlcEvent({ eventType: "smoketest_plan", startedAt: new Date().toISOString(), environments: [env], tickets: [key], sessionId }) : null;
      const message = step
        ? stepMessage(key, step.body)
        : env && running
          ? planMessage(key, env, SDLC_SCRIPT, running.id)
          : stage
            ? confirmDeployMessage(key, stage, group.prs.filter((p) => deployStageOf(p) === stage && p.state === "merged").map((p) => p.url), SDLC_SCRIPT)
            : (body.message ?? "");
      // A plan whose agent never started must not stay yellow.
      const dropRunning = () => {
        if (running && summaryDb.deleteSdlcEvent(running.id)) broadcast();
      };
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const base = join(config.handoffDir, `${key}-${stamp}`);
        mkdirSync(config.handoffDir, { recursive: true });
        writeFileSync(`${base}.md`, context);
        const name = agentName(key, step?.body ?? message);
        // Headless by default, so the page is where you talk to the agent.
        if (!body.terminal) {
          startConversation({ cwd: dir, message: agentMessage(context, message), name, sessionId, onSpawnError: dropRunning });
          if (running) broadcast();
          return json(201, { ok: true, contextFile: `${base}.md`, sessionId });
        }
        // A leading "-" would read as a pi option; the space keeps it a message.
        writeFileSync(`${base}.txt`, message.trim().startsWith("-") ? ` ${message.trim()}` : message.trim());
        const command = piCommand(dir, name, `${base}.md`, `${base}.txt`, sessionId);
        const out = await runInNewItermTab(command);
        if (out.result !== "ok") {
          dropRunning();
          return json(500, { error: out.result === "not_authorized" ? "Allow it in System Settings → Privacy & Security → Automation → iTerm2." : (out.detail ?? "could not open iTerm") });
        }
        if (running) broadcast();
        json(201, { ok: true, contextFile: `${base}.md` });
      } catch (err) {
        dropRunning();
        json(500, { error: (err as Error).message });
      }
    } else if (url.pathname === "/api/conversations" && req.method === "POST") {
      // A plain pi with no ticket and no context file, run headless so the page is its UI.
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const body = JSON.parse((await readBody(req, 64_000)) || "{}") as { message?: string; cwd?: string };
      if (!body.message?.trim()) return json(400, { error: "write the first message" });
      const dir = (body.cwd?.trim() || "~").replace(/^~(?=\/|$)/, homedir());
      if (!dir.startsWith("/") || !existsSync(dir) || !statSync(dir).isDirectory()) return json(400, { error: `not a folder: ${body.cwd}` });
      json(201, { sessionId: startConversation({ cwd: dir, message: body.message.trim() }) });
    } else if (url.pathname === "/api/conversations/end" && req.method === "POST") {
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const status = (await readReportedStatuses(config.statusDir)).get(url.searchParams.get("session") ?? "");
      // Only a headless run: a terminal pi is closed from its own tab.
      if (status?.mode !== "rpc" || !isAlive(status.pid)) return void res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no live conversation to end" }));
      process.kill(status.pid, "SIGTERM");
      res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (url.pathname === "/api/parked/dismiss" && req.method === "POST") {
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const ok = summaryDb.endParked(url.searchParams.get("session") ?? "", "dismissed");
      if (ok) broadcast();
      res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(ok ? { ok } : { error: "no parked agent with that id" }));
    } else if (url.pathname === "/api/threads" && req.method === "POST") {
      if (req.headers["x-agent-dash"] !== "1") return void res.writeHead(403).end();
      const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const ticket = url.searchParams.get("ticket") ?? "";
      const session = url.searchParams.get("session") ?? "";
      if (!new RegExp(`^${config.ticketPattern.source}$`).test(ticket)) return json(400, { error: `not a ticket key: ${ticket}` });
      if (!/^[\w-]{8,64}$/.test(session)) return json(400, { error: "not a session id" });
      const { status, reason } = JSON.parse((await readBody(req, 16_000)) || "{}") as { status?: string; reason?: string };
      if (status !== "resolved" && status !== "relevant" && status !== "unlinked") return json(400, { error: "status must be resolved, relevant or unlinked" });
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
      if (out.result === "ok") recordExit({ kind: "iterm_focus", host: "iterm", view: null, section: null, ticket: null });
      const code = out.result === "ok" ? 200 : out.result === "missing" ? 404 : 500;
      res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(out));
    } else if (url.pathname === "/api/history") {
      const [parsed, reported, pulls] = await Promise.all([sessions.scan(), readReportedStatuses(config.statusDir), prs.get(false)]);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(buildHistory(parsed, reported, pulls, Date.now(), undefined, summaryDb.currentThreadStatuses())));
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
