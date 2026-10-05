import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { REVIEW_CHANNEL } from "../../shared/reviewRequest.ts";
import type { PullRequest } from "../../shared/types.ts";
import { requestReviewDrafts } from "../reviewDrafts.ts";
import * as db from "../summaries/db.ts";

const POST_SCRIPT = new URL("../../scripts/slack-post.ts", import.meta.url).pathname;
const TEXT_MAX = 4_000;
/** PRs with a post in flight, so a double click posts once. */
const sending = new Set<string>();

export interface Posted {
  ts: string | null;
  permalink: string | null;
}

/** Posts as Piper with scripts/slack-post.ts. Rejects with the script's own message, such as a missing scope. */
export function postToSlack(channel: string, text: string): Promise<Posted> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [POST_SCRIPT, "--channel", channel], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Posted);
      } catch {
        reject(new Error(`unexpected answer from slack-post.ts: ${stdout.slice(0, 200)}`));
      }
    });
    child.stdin?.end(text);
  });
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

export interface Deps {
  /** The dashboard's PRs. A request can only name one of them. */
  prs: () => Promise<PullRequest[]>;
  onChange: () => void;
  post?: typeof postToSlack;
  draft?: Parameters<typeof requestReviewDrafts>[2];
}

/**
 * `POST /api/review-drafts`: draft a Slack review request for each open PR that has none, in the
 * background. `?pr=<url>` drafts that PR again.
 * `POST /api/review-requests` with `{prUrl, text}`: post the text to the review channel as Piper,
 * and record it as a review_request SDLC event on the PR's tickets.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, deps: Deps): Promise<boolean> {
  if (url.pathname !== "/api/review-drafts" && url.pathname !== "/api/review-requests") return false;
  // One starts paid model runs, and the other posts to Slack as Piper: another web page must not call them.
  if (req.headers["x-agent-dash"] !== "1") {
    res.writeHead(403).end();
    return true;
  }
  const json = (code: number, body: unknown) => void res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  if (req.method !== "POST") {
    json(405, { error: "POST" });
    return true;
  }
  const prs = await deps.prs();

  if (url.pathname === "/api/review-drafts") {
    const again = url.searchParams.get("pr");
    if (again !== null) {
      if (!prs.some((p) => p.url === again && p.state === "open")) {
        json(404, { error: "not one of your open PRs" });
        return true;
      }
      db.deleteReviewDraft(again);
    }
    const started = requestReviewDrafts(again === null ? prs : prs.filter((p) => p.url === again), deps.onChange, deps.draft);
    if (started.length) deps.onChange();
    json(202, { started });
    return true;
  }

  await sendReviewRequest(req, prs, deps, json);
  return true;
}

async function sendReviewRequest(req: IncomingMessage, prs: PullRequest[], deps: Deps, json: (code: number, body: unknown) => void): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req, 16_000)) || "{}") as { prUrl?: unknown; text?: unknown };
    const pr = prs.find((p) => p.url === body.prUrl);
    if (!pr) return json(404, { error: "not one of your PRs" });
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json(400, { error: "write the message" });
    if (text.length > TEXT_MAX) return json(400, { error: `the message is longer than ${TEXT_MAX} characters` });
    if (sending.has(pr.url)) return json(409, { error: "this review request is already being posted" });
    let posted: Posted;
    sending.add(pr.url);
    try {
      posted = await (deps.post ?? postToSlack)(REVIEW_CHANNEL.id, text);
    } catch (err) {
      return json(502, { error: (err as Error).message });
    } finally {
      sending.delete(pr.url);
    }
    const now = new Date().toISOString();
    // Recorded only after Slack took it, so the event means the team got the message.
    const event = db.addSdlcEvent({
      eventType: "review_request",
      startedAt: now,
      finishedAt: now,
      environments: [],
      tickets: pr.tickets,
      prUrl: pr.url,
      channel: REVIEW_CHANNEL.id,
      message: text,
      messageUrl: posted.permalink,
    });
    deps.onChange();
    json(201, event);
  } catch (err) {
    json(400, { error: (err as Error).message });
  }
}
