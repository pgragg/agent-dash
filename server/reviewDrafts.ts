import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanSummary, draftPrompt, fallbackMessage, reviewMessage, wantsReviewRequest } from "../shared/reviewRequest.ts";
import type { PullRequest } from "../shared/types.ts";
import { draftCommand } from "./agent.ts";
import { config } from "./config.ts";
import * as db from "./summaries/db.ts";

const run = promisify(execFile);

/** Each draft is its own agent process; more than this at once only slows the machine. */
const PARALLEL = 6;
/** A failed or stuck draft is tried again on a page load after this. */
const RETRY_MS = 5 * 60_000;

async function prText(url: string): Promise<{ body: string; files: string[] }> {
  try {
    const { stdout } = await run("gh", ["pr", "view", url, "--json", "body,files"], { timeout: 30_000, maxBuffer: 4_000_000 });
    const j = JSON.parse(stdout) as { body?: string; files?: { path: string }[] };
    return { body: j.body ?? "", files: (j.files ?? []).map((f) => f.path) };
  } catch {
    // The title alone still makes a fair draft.
    return { body: "", files: [] };
  }
}

/** One draft: the PR's text from gh, then one tool-less agent turn with the cheap model. */
export async function draftOne(pr: PullRequest): Promise<string> {
  const { body, files } = await prText(pr.url);
  // One short line: the cheap model is enough.
  const { cmd, args, env } = draftCommand(config.agent, draftPrompt({ repo: pr.repo, title: pr.title, body, files }));
  const agent = run(cmd, args, { timeout: 90_000, env });
  // `-p` waits for stdin to close before it starts.
  agent.child.stdin?.end();
  const { stdout } = await agent;
  const summary = cleanSummary(stdout.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""));
  return summary ? reviewMessage(summary, pr.url) : fallbackMessage(pr.title, pr.url);
}

/**
 * Starts a draft for each open PR that has none, at most PARALLEL at a time, and returns at once
 * with the PRs it took. Each finished draft calls `onChange`, so the page shows it.
 */
export function requestReviewDrafts(prs: PullRequest[], onChange: () => void, draft = draftOne, now = new Date()): string[] {
  const open = prs.filter(wantsReviewRequest);
  const claimed = new Set(db.claimReviewDrafts([...new Set(open.map((p) => p.url))], new Date(now.getTime() - RETRY_MS).toISOString(), now));
  const queue = open.filter((p) => claimed.has(p.url));
  const started = queue.map((p) => p.url);
  const worker = async () => {
    for (let pr = queue.shift(); pr; pr = queue.shift()) {
      const result = await draft(pr).then(
        (text) => ({ text }),
        (err: Error) => ({ error: err.message.split("\n").slice(-3).join(" ").slice(0, 500) }),
      );
      if (db.finishReviewDraft(pr.url, result)) onChange();
    }
  };
  // Counted first: each worker takes a PR off the queue as it starts.
  const workers = Math.min(PARALLEL, queue.length);
  for (let i = 0; i < workers; i++) void worker();
  return started;
}
