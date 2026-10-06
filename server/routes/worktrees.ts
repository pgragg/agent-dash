import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorktreeInfo } from "../../shared/types.ts";
import { config } from "../config.ts";
import { isAlive, readReportedStatuses, resolveReported } from "../sources/status.ts";
import * as db from "../summaries/db.ts";
import { mainCheckout, removeWorktree, scanWorktrees } from "../worktrees.ts";

/** agent-dash's own repo is always scanned: its old worktrees came before lanes. */
const OWN_REPO = mainCheckout(new URL("../..", import.meta.url).pathname);

async function scan(): Promise<WorktreeInfo[]> {
  const own = await OWN_REPO;
  const live = [...(await readReportedStatuses(config.statusDir)).values()].filter((s) => s.cwd && resolveReported(s, isAlive).status !== "finished").map((s) => ({ sessionId: s.sessionId, cwd: s.cwd! }));
  return scanWorktrees({ repos: [...db.laneRepos(), ...(own ? [own] : [])], lanes: db.activeLanes(), live, now: Date.now() });
}

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

/**
 * `GET /api/worktrees`: every worktree of the repos that agent-dash knows.
 * `POST /api/worktrees/cleanup` with `{path}`: remove one, after a fresh scan of it.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, onChange: () => void): Promise<boolean> {
  if (url.pathname !== "/api/worktrees" && url.pathname !== "/api/worktrees/cleanup") return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    return true;
  };
  if (url.pathname === "/api/worktrees" && req.method === "GET") return json(200, await scan());
  if (url.pathname !== "/api/worktrees/cleanup" || req.method !== "POST") return json(405, { error: "method not allowed" });
  // Same CSRF guard as the other POST routes: this deletes folders and branches.
  if (req.headers["x-agent-dash"] !== "1") return json(403, { error: "missing X-Agent-Dash header" });
  const { path } = JSON.parse((await readBody(req, 4_000)) || "{}") as { path?: string };
  // The path only picks a worktree from the server's own scan; it is never used as given.
  const w = (await scan()).find((t) => t.path === path);
  if (!w) return json(404, { error: `not a worktree that agent-dash knows: ${path}` });
  const out = await removeWorktree(w);
  if (!out.ok) return json(409, { error: out.error });
  if (w.owner?.laneId) db.setLaneState(w.owner.laneId, "removed", out.deletedBranch ? "worktree and branch removed" : `worktree removed; branch ${w.branch} kept`);
  onChange();
  return json(200, { ok: true, deletedBranch: out.deletedBranch, keptBranch: !out.deletedBranch && w.branch ? w.branch : null });
}
