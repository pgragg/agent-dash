/**
 * Starts agent-dash on fictional data only, for the README screenshots:
 *
 *   pnpm build && node scripts/demo/start.ts     # http://127.0.0.1:7790
 *
 * The server runs with HOME in /tmp/agent-dash-demo, a demo config, a fake Jira on 7791, and fake
 * `gh` and `pi` first on PATH, so it reads and writes none of your sessions, tickets, PRs or
 * settings. The drafts come from world.ts, so no model runs. Ctrl-C stops it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { PORT, ROOT } from "./config.ts";
import { CATEGORY, DOCUMENT, NEXT_STEPS, NOTES, PARKED, PRS, RUNS, TICKETS, USER, WIKI, ago, jiraIssue, prUrl } from "./world.ts";

const JIRA_PORT = PORT + 1;
const HOME = join(ROOT, "home");
/** Session folders as on Sam's Mac, so the page shows `~/src/…`. Nothing reads these folders. */
const SAM = "/Users/sam";
const REPO = new URL("../..", import.meta.url).pathname;
const now = Date.now();

rmSync(ROOT, { recursive: true, force: true });
const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// ---- settings ----------------------------------------------------------------------------
const configFile = join(ROOT, "agent-dash.config.json");
write(join(ROOT, "jira.env"), "JIRA_API_TOKEN=demo\n");
write(join(ROOT, "slack-state.json"), JSON.stringify({ cookies: [{ name: "d", domain: ".slack.com", expires: Math.floor(now / 1000) + 30 * 86_400 }] }));
// The page asks for the status extension until pi's extension folder has it. No real pi reads this folder.
write(join(HOME, ".pi/agent/extensions/agent-dash-status.ts"), "");
for (const [path, text] of Object.entries(WIKI)) write(join(ROOT, "wiki", path), text);
write(
  configFile,
  JSON.stringify(
    {
      agent: "pi",
      userName: USER,
      port: PORT,
      jiraServer: `http://127.0.0.1:${JIRA_PORT}`,
      jiraLogin: "sam@acme.example",
      jiraTokenFile: join(ROOT, "jira.env"),
      ticketProjects: ["ACME"],
      reviewChannelId: "C0ACME0001",
      reviewChannelName: "team-reviews",
      deployRepoBeta: "acme/deploy-staging",
      deployRepoProd: "acme/deploy-prod",
      slackStateFile: join(ROOT, "slack-state.json"),
      slackOrgId: "E0ACME0001",
      slackWorkspaceUrl: "https://acme.slack.com",
      environments: ["localhost", "postman_beta", "postman_prod"],
      wikiDir: join(ROOT, "wiki"),
    },
    null,
    2,
  ),
);

// ---- agent sessions and their status -----------------------------------------------------
const sleepers: ChildProcess[] = [];
for (const r of RUNS) {
  const cwd = r.cwd ? join(SAM, r.cwd) : SAM;
  const entries: unknown[] = [{ type: "session", version: 3, id: r.id, timestamp: ago(now, r.startedMin), cwd }];
  if (r.name) entries.push({ type: "session_info", name: r.name });
  let n = 0;
  for (const t of r.turns) {
    const at = ago(now, r.activeMin + 1);
    if ("user" in t) entries.push({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text: t.user }] } });
    else if ("agent" in t) entries.push({ type: "message", timestamp: at, message: { role: "assistant", model: "demo", stopReason: "stop", content: [{ type: "text", text: t.agent }] } });
    else {
      const call = `call-${++n}`;
      entries.push({ type: "message", timestamp: at, message: { role: "assistant", model: "demo", stopReason: "toolUse", content: [{ type: "toolCall", id: call, name: "bash", arguments: { command: t.tool } }] } });
      entries.push({ type: "message", timestamp: at, message: { role: "toolResult", toolCallId: call, toolName: "bash", isError: false, content: [{ type: "text", text: t.result }] } });
    }
  }
  if (r.state === "working") entries.push({ type: "message", timestamp: ago(now, r.activeMin), message: { role: "assistant", model: "demo", stopReason: "toolUse", content: [{ type: "toolCall", id: "live", name: "bash", arguments: { command: r.activity?.summary ?? "true" } }] } });
  const file = join(HOME, ".pi/agent/sessions", `-${cwd.replace(/\//g, "-")}--`, `${ago(now, r.startedMin).replace(/[:.]/g, "-")}_${r.id}.jsonl`);
  write(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const mtime = new Date(now - r.activeMin * 60_000);
  utimesSync(file, mtime, mtime);

  // A live run needs a living pid: a sleep stands in for pi.
  let pid = 999_999;
  if (r.state !== "closed") {
    const s = spawn("sleep", ["86400"], { stdio: "ignore" });
    sleepers.push(s);
    pid = s.pid!;
  }
  const status = {
    sessionId: r.id,
    pid,
    cwd,
    inbox: true,
    version: 2,
    state: r.state,
    since: ago(now, r.sinceMin),
    activity: r.activity ? { tool: r.activity.tool, summary: r.activity.summary, since: new Date(now - r.activity.sinceSec * 1000).toISOString() } : null,
    dialog: null,
  };
  write(join(HOME, ".agent-dash/status", `${r.id}.json`), JSON.stringify(status));
}

// ---- the database: notes, stars, snoozes, parks, SDLC events, drafts, a document ----------
process.env.HOME = HOME;
process.env.AGENT_DASH_CONFIG = configFile;
const db = await import("../../server/summaries/db.ts");
const at = (min: number) => new Date(now - min * 60_000);

for (const [key, notes] of Object.entries(NOTES)) for (const n of notes) db.addNote(key, n.body, at(n.minAgo));
db.setStarred("ACME-412", true);
db.setStarred("ACME-398", true);
const tomorrow9 = new Date(now + 86_400_000);
tomorrow9.setHours(9, 0, 0, 0);
db.setSnoozedUntil("ACME-405", tomorrow9);

for (const p of PARKED) {
  const r = RUNS.find((x) => x.id === p.run)!;
  db.addParked({ sessionId: r.id, ticket: p.ticket, name: r.name!, cwd: join(SAM, r.cwd), reason: p.reason, parkedAt: ago(now, p.parkedMin), needs: r.gist.needs, latest: r.gist.latest, lastMessage: (r.turns.at(-1) as { agent: string }).agent });
}

const release = PRS.find((p) => p.number === 239)!;
const search = PRS.find((p) => p.number === 77)!;
const plan = (ticket: string, env: "localhost" | "postman_beta", minAgo: number, summary: string, writes: { list: string; summary: string } | null, by = "sam") => {
  const e = db.addSdlcEvent({ eventType: "smoketest_plan", startedAt: ago(now, minAgo + 5), environments: [env], tickets: [ticket] }, at(minAgo + 5));
  db.recordPlan(e.id, { plan: `1. ${summary}\n2. Check the result.\n3. Clean up.`, stateChanges: writes?.list ?? null, plannedAt: ago(now, minAgo), summary, writesSummary: writes?.summary ?? null });
  if (writes) db.confirmPlan(e.id, ago(now, minAgo), by, at(minAgo - 2));
  return e.id;
};
const run = (ticket: string, env: "localhost" | "postman_beta", planId: number, minAgo: number, outcome: "passed" | "blocked" | "failed", summary: string, sessionId?: string) =>
  db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: ago(now, minAgo + 15), finishedAt: ago(now, minAgo), outcome, planId, summary, sessionId, testDetails: "Steps from the plan.", testResults: summary, environments: [env], tickets: [ticket] }, at(minAgo));

const local412 = plan("ACME-412", "localhost", 2 * 24 * 60 + 30, "Build a release locally from a repo with release.yml, then from one with legacy.yml", null);
run("ACME-412", "localhost", local412, 3 * 24 * 60, "failed", "Repos with release.yml got no release: the bot still read legacy.yml");
run("ACME-412", "localhost", local412, 2 * 24 * 60, "passed", "Migrated repos now build from release.yml; old repos still use legacy.yml");
db.addSdlcEvent({ eventType: "review_request", startedAt: ago(now, 30 * 60), finishedAt: ago(now, 30 * 60), prUrl: prUrl(release), channel: "C0ACME0001", message: `PR: build release targets from release.yml ${prUrl(release)}`, messageUrl: "https://acme.slack.com/archives/C0ACME0001/p1", environments: [], tickets: ["ACME-412"] }, at(30 * 60));
db.addSdlcEvent({ eventType: "deploy", startedAt: ago(now, 20 * 60), finishedAt: ago(now, 20 * 60), testDetails: "release-bot: Synced, Healthy, 4.9.20", environments: ["postman_beta"], tickets: ["ACME-412"] }, at(20 * 60));
const beta412 = plan("ACME-412", "postman_beta", 3 * 60, "Merge a test change in acme-demo/release-smoke and check that the bot builds a release from release.yml", {
  list: "Staging: create one draft release in acme-demo/release-smoke, then delete it.",
  summary: "Staging: one draft release in acme-demo/release-smoke, deleted after the test",
});
run("ACME-412", "postman_beta", beta412, 62, "blocked", "Blocked: the Staging release bot app is private to acme-demo, and the gh token has no access", RUNS[0].id);

const local398 = plan("ACME-398", "localhost", 9 * 60, "Fill the local queue with 5,000 jobs and watch the indexer scale out", null);
run("ACME-398", "localhost", local398, 8 * 60, "passed", "The indexer scaled from 2 to 6 pods at 5,000 queued jobs, and back to 2");
db.addSdlcEvent({ eventType: "review_request", startedAt: ago(now, 7 * 60), finishedAt: ago(now, 7 * 60), prUrl: prUrl(search), channel: "C0ACME0001", message: `PR: ${search.draftPhrase} ${prUrl(search)}`, messageUrl: "https://acme.slack.com/archives/C0ACME0001/p2", environments: [], tickets: ["ACME-398"] }, at(7 * 60));
// The drafts below already know these events, so the server must not draft them again.
db.claimNewEventTickets();

for (const [key, s] of Object.entries(NEXT_STEPS)) {
  const rec = db.createRequest(key, at(s.minAgo + 2));
  db.markDone(rec.id, s.text, at(s.minAgo));
}

db.addDocument({ ticket: DOCUMENT.ticket, type: "document", title: DOCUMENT.title, body: DOCUMENT.body }, at(22 * 60));

// ---- a fake Jira -------------------------------------------------------------------------
const byKey = new Map(TICKETS.map((t) => [t.key, t]));
const adf = (markdown: string) => ({ type: "doc", version: 1, content: markdownToAdf(markdown) });
const jira = createServer((req, res) => {
  const json = (v: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(v));
  const url = new URL(req.url ?? "/", "http://x");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (url.pathname === "/rest/api/3/search/jql") {
      const jql = String(JSON.parse(body || "{}").jql ?? "");
      const keys = jql.match(/[A-Z]+-\d+/g);
      const issues = jql.includes("currentUser()") ? TICKETS.filter((t) => t.status !== "Done") : TICKETS.filter((t) => keys?.includes(t.key));
      return json({ issues: issues.map((t) => jiraIssue(t, now)), isLast: true });
    }
    const m = url.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/comment|\/transitions)?$/);
    const t = m && byKey.get(m[1]);
    if (!t) return res.writeHead(404).end();
    if (req.method !== "GET") return res.writeHead(204).end();
    if (m[2] === "/comment") {
      const comments = (t.comments ?? []).map((c) => ({ author: { displayName: c.author }, created: ago(now, c.minAgo), body: adf(c.body) }));
      return json({ comments, total: comments.length });
    }
    if (m[2] === "/transitions") {
      const to = ["To Do", "In Progress", "In Review", "Done"].filter((s) => s !== t.status);
      return json({ transitions: to.map((s, i) => ({ id: String(11 + i), name: s, to: { name: s, statusCategory: { key: CATEGORY[s] } } })) });
    }
    const issue = jiraIssue(t, now);
    return json({ ...issue, fields: { ...issue.fields, description: t.description ? adf(t.description) : null } });
  });
});
await new Promise<void>((resolve) => jira.listen(JIRA_PORT, "127.0.0.1", resolve));

/** Enough markdown for the ticket descriptions: headings, numbered lists, paragraphs and `code`. */
function markdownToAdf(md: string): unknown[] {
  const inline = (s: string) => s.split(/(`[^`]+`)/).filter(Boolean).map((p) => (p.startsWith("`") ? { type: "text", text: p.slice(1, -1), marks: [{ type: "code" }] } : { type: "text", text: p }));
  const out: unknown[] = [];
  for (let block of md.split("\n\n")) {
    if (block.startsWith("## ")) {
      const [head, ...rest] = block.split("\n");
      out.push({ type: "heading", attrs: { level: 2 }, content: inline(head.slice(3)) });
      if (!rest.length) continue;
      block = rest.join("\n");
    }
    const lines = block.split("\n");
    if (/^\d+\. /.test(block)) out.push({ type: "orderedList", content: lines.map((l) => ({ type: "listItem", content: [{ type: "paragraph", content: inline(l.replace(/^\d+\. /, "")) }] })) });
    else out.push({ type: "paragraph", content: inline(block) });
  }
  return out;
}

// ---- the server ----------------------------------------------------------------------------
const server = spawn(process.execPath, [join(REPO, "server/index.ts")], {
  cwd: REPO,
  stdio: "inherit",
  // Only these variables: none of yours (AGENT_DASH_*, JIRA_*, CLAUDE_*) may reach the demo.
  env: { PATH: `${join(REPO, "scripts/demo/bin")}:${process.env.PATH}`, HOME, TMPDIR: join(ROOT, "tmp"), LANG: "en_US.UTF-8", TZ: process.env.TZ ?? "America/New_York", DEMO_NOW: String(now), AGENT_DASH_CONFIG: configFile },
});
mkdirSync(join(ROOT, "tmp"), { recursive: true });
const stop = () => {
  for (const s of sleepers) s.kill();
  server.kill();
  jira.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => {
  console.error(`agent-dash exited with ${code}`);
  stop();
});

// Each dashboard load starts the summaries, labels and review drafts; wait until they are in.
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const d = await fetch(`${base}/api/dashboard`).then((r) => (r.ok ? r.json() : null), () => null);
  if (!d) continue;
  await fetch(`${base}/api/review-drafts`, { method: "POST", headers: { "X-Agent-Dash": "1" } }).catch(() => {});
  const gists = Object.values(d.conversationSummaries ?? {}) as { status: string }[];
  const drafts = Object.values(d.reviewDrafts ?? {}) as { status: string }[];
  if (gists.length && gists.every((g) => g.status !== "in_progress") && drafts.length && drafts.every((x) => x.status !== "in_progress")) {
    console.log(`\nThe demo dashboard is ready: ${base}`);
    break;
  }
}
