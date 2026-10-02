import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import type { PrCheck, PrDetail } from "../../shared/types.ts";
import { config } from "../config.ts";
import { checkState, contextName, contextState } from "../sources/github.ts";
import { extractTickets } from "../sources/sessions.ts";

/** GET /api/pr?ref=owner/repo/number: one PR in full, for the PR panel. Read-only, through the `gh` login. */

const run = promisify(execFile);

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url number title state isDraft body baseRefName headRefName reviewDecision mergeable additions deletions changedFiles updatedAt
      author { login }
      repository { nameWithOwner }
      reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
      latestReviews(first: 20) { nodes { author { login } state } }
      files(first: 100) { nodes { path additions deletions } }
      reviewThreads(first: 100) { nodes { isResolved isOutdated path line originalLine comments(first: 30) { nodes { author { login } body createdAt url } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
        ... on CheckRun { name status conclusion detailsUrl databaseId checkSuite { app { slug } } }
        ... on StatusContext { context state targetUrl }
      } } } } } }
    }
  }
}`;

/** GitHub's own limits on owner and repo names, so nothing else reaches `gh`. */
const REF = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/([1-9]\d{0,8})$/;

export function parseRef(ref: string): { owner: string; name: string; number: number } | null {
  const m = ref.match(REF);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return { owner: m[1], name: m[2], number: Number(m[3]) };
}

const MAX_LOGS = 3;
const TAIL_LINES = 40;
const TAIL_CHARS = 4000;

/**
 * The end of a job log, up to its last `##[error]` line. Cleanup steps run after the
 * failure, so the plain end of the log is mostly noise.
 */
export function logTail(text: string, maxLines = TAIL_LINES, maxChars = TAIL_CHARS): string {
  const lines = text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("##[error]")) {
      end = i + 1;
      break;
    }
  }
  const tail = lines.slice(Math.max(0, end - maxLines), end).join("\n");
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/** An Actions check run's id is its job id, which the log endpoint takes. Stays on the server. */
type CheckWithJob = PrCheck & { jobId?: number };

/** The GraphQL answer as the panel needs it. Resolved review threads are left out. */
export function toDetail(pr: any, ticketPattern: RegExp, now = new Date()): Omit<PrDetail, "checkRuns"> & { checkRuns: CheckWithJob[] } {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const checkRuns: CheckWithJob[] = (rollup?.contexts?.nodes ?? [])
    .filter((c: any) => c && (c.name || c.context))
    .map((c: any) => ({
      name: contextName(c),
      state: contextState(c),
      url: c.detailsUrl ?? c.targetUrl ?? null,
      ...(c.checkSuite?.app?.slug === "github-actions" && c.databaseId ? { jobId: c.databaseId } : {}),
    }));
  return {
    url: pr.url,
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title,
    state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
    isDraft: pr.isDraft,
    author: pr.author?.login ?? null,
    body: pr.body ?? "",
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    reviewDecision: pr.reviewDecision ?? null,
    mergeable: pr.mergeable ?? "UNKNOWN",
    checks: checkState(rollup?.state),
    checkRuns,
    threads: (pr.reviewThreads?.nodes ?? [])
      .filter((t: any) => t && !t.isResolved)
      .map((t: any) => ({
        path: t.path,
        line: t.line ?? t.originalLine ?? null,
        isOutdated: !!t.isOutdated,
        comments: (t.comments?.nodes ?? []).map((c: any) => ({ author: c.author?.login ?? "ghost", body: c.body ?? "", createdAt: c.createdAt, url: c.url })),
      })),
    reviewers: (pr.latestReviews?.nodes ?? []).map((r: any) => ({ login: r.author?.login ?? "ghost", state: r.state })),
    requestedReviewers: (pr.reviewRequests?.nodes ?? []).map((r: any) => r.requestedReviewer?.login ?? r.requestedReviewer?.name).filter(Boolean),
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    files: (pr.files?.nodes ?? []).map((f: any) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
    updatedAt: pr.updatedAt,
    tickets: extractTickets(`${pr.title} ${pr.headRefName}`, ticketPattern),
    fetchedAt: now.toISOString(),
  };
}

async function fetchLogTail(repo: string, jobId: number): Promise<string | undefined> {
  try {
    // gh refuses to print a log with colour codes unless told to; logTail strips them.
    const { stdout } = await run("gh", ["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${jobId}/logs`], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
    return logTail(stdout);
  } catch {
    return undefined;
  }
}

async function fetchPrDetail(ref: { owner: string; name: string; number: number }): Promise<PrDetail> {
  const { stdout } = await run(
    "gh",
    ["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${ref.owner}`, "-f", `name=${ref.name}`, "-F", `number=${ref.number}`],
    { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
  );
  const pr = JSON.parse(stdout).data?.repository?.pullRequest;
  if (!pr) throw new Error(`no such PR: ${ref.owner}/${ref.name}#${ref.number}`);
  const detail = toDetail(pr, config.ticketPattern);
  const failed = detail.checkRuns.filter((c) => c.state === "failure" && c.jobId).slice(0, MAX_LOGS);
  await Promise.all(failed.map(async (c) => (c.logTail = await fetchLogTail(detail.repo, c.jobId!))));
  return { ...detail, checkRuns: detail.checkRuns.map(({ jobId: _job, ...c }) => c) };
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<PrDetail> }>();

function cached(key: string, ref: NonNullable<ReturnType<typeof parseRef>>, force: boolean): Promise<PrDetail> {
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.value;
  for (const [k, v] of cache) if (Date.now() - v.at >= TTL_MS) cache.delete(k);
  const value = fetchPrDetail(ref);
  cache.set(key, { at: Date.now(), value });
  // A failure is not cached, so the next open tries again.
  value.catch(() => cache.get(key)?.value === value && cache.delete(key));
  return value;
}

export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/pr" || req.method !== "GET") return false;
  const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  const raw = url.searchParams.get("ref") ?? "";
  const ref = parseRef(raw);
  if (!ref) {
    json(400, { error: `not a PR ref (owner/repo/number): ${raw.slice(0, 200)}` });
    return true;
  }
  try {
    json(200, await cached(raw.toLowerCase(), ref, url.searchParams.has("refresh")));
  } catch (err) {
    // gh's own message is in stderr; the error message repeats the whole command line.
    const e = err as Error & { stderr?: string };
    json(502, { error: (e.stderr?.trim() || e.message).split("\n")[0].slice(0, 500) });
  }
  return true;
}
