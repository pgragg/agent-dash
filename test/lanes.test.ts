import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLanes, LaneError, laneGit, listWorktrees, planLanes } from "../server/lanes.ts";
import { startLanes } from "../server/routes/lanes.ts";
import * as db from "../server/summaries/db.ts";
import { laneAgentName, laneBrief, laneGitText, lanesProblem } from "../shared/lanes.ts";

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
});
