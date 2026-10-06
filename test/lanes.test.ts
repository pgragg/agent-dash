import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLanes, LaneError, laneGit, listWorktrees, planLanes } from "../server/lanes.ts";
import { land, openPr, startLanes } from "../server/routes/lanes.ts";
import { landLane } from "../server/land.ts";
import { cleanupBlocker, deletesBranch, removeWorktree, scanWorktrees } from "../server/worktrees.ts";
import * as db from "../server/summaries/db.ts";
import { landBlocker, laneAgentName, laneBrief, laneGitText, lanesProblem } from "../shared/lanes.ts";

const NOW_MS = Date.parse("2026-10-06T12:00:00Z");
const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-dash-lanes-")));
db.open(join(root, "test.db"));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A bare origin with one commit on main, and a fresh clone of it in its own folder. */
function repo(name: string): string {
  const dir = join(root, name);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", `${dir}-origin.git`]);
  execFileSync("git", ["clone", "-q", `${dir}-origin.git`, join(dir, "app")], { stdio: "ignore" });
  const app = join(dir, "app");
  sh(app, "config", "user.email", "t@t");
  sh(app, "config", "user.name", "t");
  writeFileSync(join(app, "a.txt"), "one\n");
  sh(app, "add", "-A");
  sh(app, "commit", "-qm", "init");
  sh(app, "push", "-q", "origin", "main");
  sh(app, "remote", "set-head", "origin", "main");
  return app;
}

test("lane requests need two to six lanes with plain, unique names and a message each", () => {
  assert.match(lanesProblem([{ name: "a", message: "x" }])!, /at least two/);
  assert.match(lanesProblem([{ name: "a", message: "x" }, { name: "a", message: "y" }])!, /two lanes are named a/);
  assert.match(lanesProblem([{ name: "a", message: "x" }, { name: "B c", message: "y" }])!, /not a lane name/);
  assert.match(lanesProblem([{ name: "a", message: "x" }, { name: "b", message: " " }])!, /first message of lane b/);
  assert.equal(lanesProblem([{ name: "a", message: "x" }, { name: "api-2", message: "y" }]), null);
});

test("land mode makes one integration worktree per ticket and a worktree per lane from it", async () => {
  const app = repo("land");
  const plan = await planLanes(app, "AD-20", ["a", "b", "c"], "land");
  assert.equal(plan.base, "main");
  assert.deepEqual(plan.integration, { branch: "ad-20", worktree: join(root, "land", "app-ad-20"), create: true });
  await createLanes(plan);
  const trees = await listWorktrees(app);
  assert.deepEqual(trees.map((t) => t.branch).sort(), ["ad-20", "ad-20-a", "ad-20-b", "ad-20-c", "main"]);
  assert.equal(sh(join(root, "land", "app-ad-20-b"), "rev-parse", "HEAD"), sh(app, "rev-parse", "ad-20"));
  // A pull in a lane must not merge the base by surprise.
  assert.throws(() => sh(join(root, "land", "app-ad-20-a"), "rev-parse", "--abbrev-ref", "@{upstream}"));

  // A second request reuses the integration worktree, and refuses a lane that exists.
  const again = await planLanes(join(root, "land", "app-ad-20-a"), "AD-20", ["d"], "land");
  assert.equal(again.integration?.create, false);
  assert.equal(again.repo, app);
  await assert.rejects(planLanes(app, "AD-20", ["d", "a"], "land"), /exists already/);
});

test("pr mode branches each lane from the base on origin, with no integration worktree", async () => {
  const app = repo("pr");
  const plan = await planLanes(app, "FSDK-7", ["x", "y"], "pr", "origin/main");
  assert.equal(plan.integration, null);
  await createLanes(plan);
  assert.equal(sh(join(root, "pr", "app-fsdk-7-x"), "rev-parse", "HEAD"), sh(app, "rev-parse", "origin/main"));
  assert.equal(existsSync(join(root, "pr", "app-fsdk-7")), false);
});

test("a shallow clone is refused before any worktree is made", async () => {
  const app = repo("deep");
  const shallow = join(root, "shallow");
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${join(root, "deep")}-origin.git`, shallow], { stdio: "ignore" });
  await assert.rejects(planLanes(shallow, "AD-20", ["a", "b"], "land"), (e: Error) => e instanceof LaneError && /shallow clone/.test(e.message));
  assert.equal((await listWorktrees(shallow)).length, 1);
  assert.ok(app);
});

test("a failed lane removes the worktrees that the same request made", async () => {
  const app = repo("rollback");
  const plan = await planLanes(app, "AD-20", ["a", "b"], "land");
  // Taken after the plan, as by a parallel request.
  sh(app, "branch", "ad-20-b");
  await assert.rejects(createLanes(plan), /worktree add failed/);
  assert.deepEqual((await listWorktrees(app)).map((t) => t.branch), ["main"]);
  assert.equal(sh(app, "branch", "--list", "ad-20", "ad-20-a"), "");
});

test("lane git state counts commits against its base and files that are not committed", async () => {
  const app = repo("state");
  const plan = await planLanes(app, "AD-20", ["a", "b"], "land");
  await createLanes(plan);
  const a = join(root, "state", "app-ad-20-a");
  writeFileSync(join(a, "b.txt"), "new\n");
  sh(a, "add", "-A");
  sh(a, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "lane a");
  writeFileSync(join(a, "c.txt"), "wip\n");
  writeFileSync(join(a, "a.txt"), "changed\n");
  const lane = { worktree: a, mode: "land" as const, base: "main", integrationBranch: "ad-20" };
  assert.deepEqual(await laneGit(lane), { head: "ad-20-a", ahead: 1, behind: 0, dirty: 2 });
  assert.equal(await laneGit({ ...lane, worktree: join(root, "gone") }), null);
});

test("starting lanes saves a row per lane and starts each agent in its own worktree with a brief", async () => {
  const app = repo("start");
  const started: { cwd: string; message?: string; name?: string; sessionId?: string }[] = [];
  const out = await startLanes(
    { key: "AD-20", context: "# AD-20 context", cwd: app, mode: "land", brief: "Shared brief.", lanes: [{ name: "api", message: "Build the API" }, { name: "ui", message: "Build the UI" }] },
    (o) => {
      started.push(o);
      return o.sessionId!;
    },
  );
  assert.equal(out.status, 201);
  assert.deepEqual(started.map((s) => s.cwd), [join(root, "start", "app-ad-20-api"), join(root, "start", "app-ad-20-ui")]);
  assert.equal(started[0].name, "AD-20/api: Build the API");
  assert.match(started[0].message!, /^# AD-20 context\n\n## Your lane/);
  assert.match(started[0].message!, /`ui` \(Build the UI\)/);
  assert.match(started[0].message!, /Shared brief\.\n\nBuild the API$/);
  const rows = db.activeLanes().filter((l) => l.repo === app);
  assert.deepEqual(rows.map((r) => [r.lane, r.branch, r.integrationBranch, r.sessionId]), [
    ["api", "ad-20-api", "ad-20", started[0].sessionId],
    ["ui", "ad-20-ui", "ad-20", started[1].sessionId],
  ]);

  // A clash with git state is a 409, and starts nothing.
  const clash = await startLanes({ key: "AD-20", context: "", cwd: app, mode: "land", lanes: [{ name: "api", message: "x" }, { name: "z", message: "y" }] }, () => assert.fail("must not start"));
  assert.equal(clash.status, 409);
  assert.equal(db.activeLanes().filter((l) => l.repo === app).length, 2);
});

test("the brief tells a pr-mode lane to open its own PR, and a land-mode lane not to push", () => {
  const me = { id: 3, lane: "a", branch: "ad-1-a", worktree: "/r-ad-1-a", base: "main", integrationBranch: "ad-1", goal: "x" };
  assert.match(laneBrief("AD-1", { ...me, mode: "land" }, [{ lane: "b", goal: "y" }]), /Do not push, and do not open a PR: agent-dash lands each lane into `ad-1`/);
  assert.match(laneBrief("AD-1", { ...me, mode: "pr", integrationBranch: null }, [{ lane: "b", goal: "y" }]), /open a PR into `main` with `AD-1` in its title/);
  assert.match(laneBrief("AD-1", { ...me, mode: "land" }, []), /port 7803/);
  assert.equal(laneAgentName("AD-1", "a", "**Fix** the `x`\nmore"), "AD-1/a: Fix the x");
});

test("a lane's git state reads as a few words, and a switched branch or a gone worktree is a warning", () => {
  const l = { branch: "ad-1-a", mode: "land" as const, base: "main", integrationBranch: "ad-1" };
  assert.deepEqual(laneGitText({ ...l, git: { head: "ad-1-a", ahead: 2, behind: 1, dirty: 3 } }), { text: "2 ahead · 1 behind ad-1 · 3 uncommitted", warn: false });
  assert.deepEqual(laneGitText({ ...l, mode: "pr", git: { head: "ad-1-a", ahead: 0, behind: 4, dirty: 0 } }), { text: "no commits yet · 4 behind origin/main", warn: false });
  assert.deepEqual(laneGitText({ ...l, git: { head: "main", ahead: 0, behind: 0, dirty: 0 } }), { text: "on main, not ad-1-a", warn: true });
  assert.deepEqual(laneGitText({ ...l, git: null }), { text: "worktree gone", warn: true });
  assert.deepEqual(laneGitText({ ...l, landedAt: "2026-10-06T00:00:00Z", git: { head: "ad-1-a", ahead: 0, behind: 2, dirty: 0 } }), { text: "all landed · 2 behind ad-1", warn: false });
});

// ---- AD-21: Land -------------------------------------------------------------------------

let ticketCount = 0;

/** Three lanes on a fresh repo: a and b change the same line, c adds a file. Commits are made, nothing is landed. */
async function threeLanes(name: string, pkg?: object): Promise<{ app: string; dir: (l: string) => string; rows: db.LaneRecord[] }> {
  const app = repo(name);
  if (pkg) {
    writeFileSync(join(app, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(app, "check.mjs"), 'import { readFileSync } from "node:fs"; if (readFileSync("a.txt", "utf8").includes("BAD")) { console.log("a.txt is BAD"); process.exit(1); }\n');
    sh(app, "add", "-A");
    sh(app, "commit", "-qm", "checks");
    sh(app, "push", "-q", "origin", "main");
  }
  const key = `AD-${900 + ++ticketCount}`;
  const out = await startLanes({ key, context: "", cwd: app, mode: "land", lanes: ["a", "b", "c"].map((n) => ({ name: n, message: `lane ${n}` })) }, (o) => o.sessionId!);
  assert.equal(out.status, 201);
  const rows = db.activeLanes().filter((l) => l.repo === app);
  const dir = (l: string) => rows.find((r) => r.lane === l)!.worktree;
  const commit = (l: string, file: string, text: string) => {
    writeFileSync(join(dir(l), file), text);
    sh(dir(l), "add", "-A");
    sh(dir(l), "commit", "-qm", `lane ${l}`);
  };
  commit("a", "a.txt", "one from a\n");
  commit("b", "a.txt", "one from b\n");
  commit("c", "c.txt", "c\n");
  return { app, dir, rows };
}

test("land: lanes go in one at a time, a conflict goes back to its lane's agent, and the fix lands", async () => {
  const { dir, rows } = await threeLanes("land-flow");
  const id = (l: string) => rows.find((r) => r.lane === l)!.id;
  const sent: { session: string; text: string }[] = [];
  const deps = { context: async () => "", onChange: () => {}, agentWorking: async () => false, inbox: (session: string, _s: string, text: string) => void sent.push({ session, text }) };

  // a and c at once: the queue runs them in turn, and both go in.
  const [a, c] = await Promise.all([land(id("a"), deps), land(id("c"), deps)]);
  assert.equal((a.body as { ok: boolean }).ok, true);
  assert.equal((c.body as { ok: boolean }).ok, true);
  const integration = rows[0].integrationWorktree!;
  assert.equal(sh(integration, "log", "--format=%s", "-3"), "lane c\nlane a\ninit");

  const b = await land(id("b"), deps);
  assert.deepEqual((b.body as { kind: string; files: string[] }).files, ["a.txt"]);
  assert.equal(db.getLane(id("b"))!.state, "conflict");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].session, rows.find((r) => r.lane === "b")!.sessionId);
  assert.match(sent[0].text, /Conflicting files: `a\.txt`/);
  // The abort leaves the lane as it was, with nothing half-rebased.
  assert.equal(sh(dir("b"), "status", "--porcelain"), "");
  assert.equal(sh(dir("b"), "log", "--format=%s", "-1"), "lane b");

  // The agent resolves it as the message says.
  assert.throws(() => sh(dir("b"), "rebase", rows[0].integrationBranch!));
  writeFileSync(join(dir("b"), "a.txt"), "one from a and b\n");
  sh(dir("b"), "add", "a.txt");
  execFileSync("git", ["-C", dir("b"), "-c", "core.editor=true", "rebase", "--continue"], { stdio: "ignore" });
  const again = await land(id("b"), deps);
  assert.equal((again.body as { ok: boolean }).ok, true);
  assert.equal(db.getLane(id("b"))!.state, "landed");
  assert.equal(sh(integration, "log", "--format=%s", "-4"), "lane b\nlane c\nlane a\ninit");
  assert.equal(sh(integration, "show", "HEAD:a.txt"), "one from a and b");
});

test("land: refuses a working agent, uncommitted files, a moved integration worktree, and a lane with nothing new", async () => {
  const { dir, rows } = await threeLanes("land-refuse");
  const lane = (l: string) => rows.find((r) => r.lane === l)!;
  const opts = { agentWorking: false, checks: async () => ({ ok: true, ran: [], output: "" }) };
  assert.match((await landLane(lane("a"), { ...opts, agentWorking: true }) as { message: string }).message, /agent is working/);
  writeFileSync(join(dir("a"), "wip.txt"), "wip\n");
  assert.match((await landLane(lane("a"), opts) as { message: string }).message, /1 uncommitted files/);
  execFileSync("rm", [join(dir("a"), "wip.txt")]);
  const integration = lane("a").integrationWorktree!;
  sh(integration, "switch", "-q", "--detach");
  assert.match((await landLane(lane("a"), opts) as { message: string }).message, /integration worktree is on a detached HEAD/);
  sh(integration, "switch", "-q", lane("a").integrationBranch!);
  assert.equal((await landLane(lane("a"), opts)).ok, true);
  assert.match((await landLane(lane("a"), opts) as { message: string }).message, /no commits that/);
});

test("land: red checks keep the integration branch where it was, and send the output to the agent", async () => {
  const { dir, rows } = await threeLanes("land-checks", { type: "module", scripts: { test: "node check.mjs" } });
  const b = rows.find((r) => r.lane === "b")!;
  writeFileSync(join(dir("b"), "a.txt"), "BAD\n");
  sh(dir("b"), "commit", "-qam", "break it");
  const sent: string[] = [];
  const before = sh(b.integrationWorktree!, "rev-parse", "HEAD");
  const out = await land(b.id, { context: async () => "", onChange: () => {}, agentWorking: async () => false, inbox: (_s, _x, text) => void sent.push(text) });
  assert.equal((out.body as { kind: string }).kind, "checks");
  assert.equal(db.getLane(b.id)!.state, "checks_failed");
  assert.equal(sh(b.integrationWorktree!, "rev-parse", "HEAD"), before);
  assert.match(sent[0], /a\.txt is BAD/);
  // With the checks green, the land goes in and names what ran.
  writeFileSync(join(dir("b"), "a.txt"), "fine\n");
  sh(dir("b"), "commit", "-qam", "fix it");
  const ok = await land(b.id, { context: async () => "", onChange: () => {}, agentWorking: async () => false });
  assert.deepEqual((ok.body as { checks: string[] }).checks, ["npm run test"]);
  assert.match(db.getLane(b.id)!.note!, /landed 3 commits after npm run test/);
});

test("open PR: needs a landed lane, and starts an agent in the integration worktree", async () => {
  const { rows } = await threeLanes("land-pr");
  const key = rows[0].ticket;
  const started: { cwd: string; message?: string; name?: string }[] = [];
  const deps = { context: async () => "# ctx", onChange: () => {}, agentWorking: async () => false, start: (o: { cwd: string; message?: string; name?: string }) => (started.push(o), "s") };
  assert.equal((await openPr(key, "Title", deps)).status, 409);
  await land(rows[0].id, deps);
  assert.equal((await openPr(key, "Title", deps)).status, 201);
  assert.equal(started[0].cwd, rows[0].integrationWorktree);
  assert.match(started[0].message!, new RegExp(`titled \`${key}: Title\``));
  assert.match(started[0].message!, /lane `b` \(not landed: working\)/);
});

test("Land is on only for a land-mode lane with new commits, no uncommitted files, and an idle agent", () => {
  const l = { mode: "land" as const, state: "working" as const, branch: "ad-1-a", integrationBranch: "ad-1", git: { head: "ad-1-a", ahead: 1, behind: 0, dirty: 0 } };
  assert.equal(landBlocker(l, false), null);
  assert.equal(landBlocker(l, true), "its agent is working");
  assert.equal(landBlocker({ ...l, git: { ...l.git, dirty: 2 } }, false), "2 files are not committed");
  assert.equal(landBlocker({ ...l, git: { ...l.git, ahead: 0 } }, false), "no commits that ad-1 does not have");
  assert.equal(landBlocker({ ...l, mode: "pr" }, false), "this lane opens its own PR");
  assert.equal(landBlocker({ ...l, state: "landing" }, false), "it is landing now");
  // A lane that hit a conflict lands again once its agent fixed it.
  assert.equal(landBlocker({ ...l, state: "conflict" as never }, false), null);
});

// ---- AD-22: Clean up -----------------------------------------------------------------------

/** Makes git think the worktree was last used `days` ago. */
function age(path: string, days: number): void {
  const gitDir = sh(path, "rev-parse", "--path-format=absolute", "--git-dir");
  const t = new Date(Date.now() - days * 86_400_000);
  utimesSync(join(gitDir, "logs", "HEAD"), t, t);
}

test("clean up: never the main checkout, a live agent's folder, uncommitted files, a fresh orphan, or a lone detached HEAD", () => {
  const f = { main: false, branch: "x", dirty: 0, ahead: 0, contained: true, prState: null, lastUsedAt: new Date(NOW_MS - 3 * 86_400_000).toISOString(), liveSession: null, owned: false };
  assert.equal(cleanupBlocker(f, NOW_MS), null);
  assert.equal(cleanupBlocker({ ...f, main: true }, NOW_MS), "the repo's main checkout");
  assert.equal(cleanupBlocker({ ...f, liveSession: "s" }, NOW_MS), "a live agent works here");
  assert.equal(cleanupBlocker({ ...f, dirty: 1 }, NOW_MS), "1 uncommitted file");
  assert.equal(cleanupBlocker({ ...f, lastUsedAt: new Date(NOW_MS - 3_600_000).toISOString() }, NOW_MS), "used in the last 24 hours");
  // A lane's own worktree has its agent's status, so the quiet time does not apply.
  assert.equal(cleanupBlocker({ ...f, owned: true, lastUsedAt: new Date(NOW_MS).toISOString() }, NOW_MS), null);
  assert.equal(cleanupBlocker({ ...f, branch: null, contained: false, ahead: 2 }, NOW_MS), "a detached HEAD with 2 commits that the base does not have");
  assert.equal(cleanupBlocker({ ...f, owned: true, lanesUseIt: true }, NOW_MS), "its lanes still land here; clean them up first");
  assert.equal(deletesBranch({ branch: "x", contained: false, prState: "MERGED" }), true);
  assert.equal(deletesBranch({ branch: "x", contained: false, prState: "CLOSED" }), false);
  assert.equal(deletesBranch({ branch: "x", contained: false, prState: null, landed: true }), true);
});

test("clean up: orphans with merged work go with their branch, unmerged branches stay, and dirty or fresh ones say why not", async () => {
  const app = repo("orphans");
  const add = (name: string, from = "origin/main") => {
    const path = join(root, "orphans", `app-${name}`);
    sh(app, "worktree", "add", "-q", "-b", name, path, from);
    return path;
  };
  const merged = add("merged");
  const squashed = add("squashed");
  writeFileSync(join(squashed, "s.txt"), "s\n");
  sh(squashed, "add", "-A");
  sh(squashed, "commit", "-qm", "squashed work");
  const unmerged = add("unmerged");
  writeFileSync(join(unmerged, "u.txt"), "u\n");
  sh(unmerged, "add", "-A");
  sh(unmerged, "commit", "-qm", "only here");
  const dirty = add("dirty");
  writeFileSync(join(dirty, "wip.txt"), "wip\n");
  const fresh = add("fresh");
  const busy = add("busy");
  for (const p of [merged, squashed, unmerged, dirty, busy]) age(p, 3);

  const scanNow = () =>
    scanWorktrees({ repos: [app], lanes: [], live: [{ sessionId: "live-1", cwd: join(busy, "src") }], now: Date.now(), pr: async (_slug, b) => (b === "squashed" ? { url: "https://github.com/o/r/pull/9", state: "MERGED" } : null) });
  // PRs are only looked up on GitHub; the scan itself reads local refs only.
  sh(app, "remote", "set-url", "origin", "https://github.com/o/r.git");
  const byName = async () => new Map((await scanNow()).map((w) => [w.branch, w]));
  let w = await byName();
  assert.equal(w.get("main")!.blocker, "the repo's main checkout");
  assert.equal(w.get("merged")!.blocker, null);
  assert.equal(w.get("merged")!.deletesBranch, true);
  // A squash merge leaves the branch's commits off main; the merged PR says the work is safe.
  assert.equal(w.get("squashed")!.contained, false);
  assert.equal(w.get("squashed")!.deletesBranch, true);
  assert.deepEqual(w.get("squashed")!.pr, { url: "https://github.com/o/r/pull/9", state: "MERGED" });
  assert.equal(w.get("unmerged")!.blocker, null);
  assert.equal(w.get("unmerged")!.deletesBranch, false);
  assert.equal(w.get("dirty")!.blocker, "1 uncommitted file");
  assert.equal(w.get("fresh")!.blocker, "used in the last 24 hours");
  assert.equal(w.get("busy")!.blocker, "a live agent works here");

  assert.deepEqual(await removeWorktree(w.get("merged")!), { ok: true, deletedBranch: true });
  assert.deepEqual(await removeWorktree(w.get("unmerged")!), { ok: true, deletedBranch: false });
  assert.match(sh(app, "branch", "--list", "unmerged"), /unmerged/);
  assert.equal(existsSync(unmerged), false);
  assert.deepEqual(await removeWorktree(w.get("dirty")!), { ok: false, error: `cannot clean up ${dirty}: 1 uncommitted file` });
  assert.equal(existsSync(join(dirty, "wip.txt")), true);

  // A file that appears after the scan: git itself refuses, because there is no --force.
  w = await byName();
  writeFileSync(join(fresh, "late.txt"), "late\n");
  assert.equal((await removeWorktree({ ...w.get("fresh")!, blocker: null })).ok, false);
  assert.equal(existsSync(join(fresh, "late.txt")), true);
});

test("clean up: a landed lane goes with its branch, and the integration worktree waits for its lanes", async () => {
  const { app, rows } = await threeLanes("cleanup-lanes");
  const deps = { context: async () => "", onChange: () => {}, agentWorking: async () => false, inbox: () => {} };
  await land(rows.find((r) => r.lane === "c")!.id, deps);
  const scan = async () => new Map((await scanWorktrees({ repos: [app], lanes: db.activeLanes().filter((l) => l.repo === app), live: [], now: Date.now(), pr: async () => null })).map((w) => [w.path, w]));
  let w = await scan();
  const c = w.get(rows.find((r) => r.lane === "c")!.worktree)!;
  const a = w.get(rows.find((r) => r.lane === "a")!.worktree)!;
  assert.deepEqual(c.owner, { ticket: rows[0].ticket, laneId: rows.find((r) => r.lane === "c")!.id, lane: "c" });
  assert.equal(c.blocker, null);
  assert.equal(c.deletesBranch, true);
  assert.equal(a.deletesBranch, false);
  assert.equal(w.get(rows[0].integrationWorktree!)!.blocker, "its lanes still land here; clean them up first");
  assert.deepEqual(await removeWorktree(c), { ok: true, deletedBranch: true });
});
