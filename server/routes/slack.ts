import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { citedSlack, parseSlackHits } from "../../shared/slackQuotes.ts";
import * as summaryDb from "../summaries/db.ts";
import { SLACK_HITS } from "../summaries/runner.ts";

/** `GET /api/summaries/slack?id=N`: the Slack messages that summary N links to, with their text. */
export async function handle(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/summaries/slack") return false;
  const rec = summaryDb.get(Number(url.searchParams.get("id")));
  // The work folder comes from the database row, never from the request.
  const raw = rec?.workDir ? await readFile(join(rec.workDir, SLACK_HITS), "utf8").catch(() => "") : "";
  const quotes = rec?.summary ? citedSlack(rec.summary, parseSlackHits(raw)) : [];
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(quotes));
  return true;
}
