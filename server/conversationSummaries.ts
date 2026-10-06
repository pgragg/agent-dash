import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { GIST_VERSION, gistPrompt, parseGist, type ConversationGist } from "../shared/conversationSummary.ts";
import type { ConversationSummary, Run } from "../shared/types.ts";
import { digestSession } from "./sources/sessions.ts";
import * as db from "./summaries/db.ts";

const run = promisify(execFile);

/** Three short lines: a small, fast model is enough. */
const MODEL = process.env.AGENT_DASH_DRAFT_MODEL ?? "anthropic/claude-haiku-4-5";
/** Each draft is its own pi process; more than this at once only slows the machine. */
const PARALLEL = 4;
/** A failed or stuck draft is tried again after this. */
const RETRY_MS = 5 * 60_000;
/** The newest part of the chat. The latest message and the open question are at the end. */
const DIGEST_CHARS = 16_000;

/**
 * The state of the run that a summary describes: a new prompt, a new last message, or the end of
 * the conversation makes a new one.
 */
export function basisOf(r: Run): string {
  const hash = createHash("sha1").update(r.lastMessage).digest("hex").slice(0, 12);
  // A draft made while the agent worked cannot say what it needs once it stops.
  return `v${GIST_VERSION}:${r.userMessageCount}:${hash}:${r.status === "finished" ? "end" : r.status === "working" ? "work" : "live"}`;
}

/**
 * The runs to draft now. A working run changes its last message on every turn, so it gets a
 * draft only when it has none yet; it gets a new one when it stops.
 */
export function runsToDraft(runs: Run[], rows: Map<string, db.ConversationSummaryRow>, retryBefore: string): Run[] {
  return runs.filter((r) => {
    if (!r.lastMessage) return false;
    const row = rows.get(r.sessionId);
    if (!row) return true;
    if (row.status !== "done" && row.requestedAt < retryBefore) return true;
    if (r.status === "working") return false;
    return row.basis !== basisOf(r) && row.status !== "in_progress";
  });
}

/** One draft: the chat without tool traffic, then one tool-less pi turn with the cheap model. */
export async function draftOne(r: Run, file: string): Promise<ConversationGist> {
  const digest = digestSession(await readFile(file, "utf8"), DIGEST_CHARS);
  const args = ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--model", MODEL, "--thinking", "off"];
  const pi = run("pi", [...args, gistPrompt(r.status, digest)], {
    timeout: 90_000,
    // The `pi` shell alias sets this; a spawned pi does not get the alias.
    env: { ...process.env, SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? "/etc/ssl/cert.pem" },
  });
  // pi -p waits for stdin to close before it starts.
  pi.child.stdin?.end();
  const { stdout } = await pi;
  const gist = parseGist(stdout.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""));
  if (!gist) throw new Error(`the model did not answer in the ABOUT, LATEST, NEEDS format: ${stdout.slice(0, 200)}`);
  return gist;
}

/**
 * Starts a draft for each run whose summary is missing or out of date, at most PARALLEL at a time,
 * and returns at once with the session ids it took. It reads the table first and writes only for
 * a real claim, because each write reloads the page, and each page load calls this again.
 */
export function requestConversationSummaries(runs: Run[], fileFor: (sessionId: string) => string | null, onChange: () => void, draft = draftOne, now = new Date()): string[] {
  const retryBefore = new Date(now.getTime() - RETRY_MS).toISOString();
  const unique = [...new Map(runs.map((r) => [r.sessionId, r])).values()];
  const queue = runsToDraft(unique, db.conversationSummaries(), retryBefore)
    .map((r) => ({ r, basis: basisOf(r), file: fileFor(r.sessionId) }))
    .filter((x): x is { r: Run; basis: string; file: string } => !!x.file && db.claimConversationSummary(x.r.sessionId, x.basis, retryBefore, now));
  const started = queue.map((x) => x.r.sessionId);
  const worker = async () => {
    for (let x = queue.shift(); x; x = queue.shift()) {
      const result = await draft(x.r, x.file).then(
        (gist) => gist,
        (err: Error) => ({ error: err.message.split("\n").slice(-3).join(" ").slice(0, 500) }),
      );
      if (db.finishConversationSummary(x.r.sessionId, x.basis, result)) onChange();
    }
  };
  // Counted first: each worker takes a run off the queue as it starts.
  const workers = Math.min(PARALLEL, queue.length);
  for (let i = 0; i < workers; i++) void worker();
  if (started.length) onChange();
  return started;
}

/** The summaries of the given runs, for the page, each marked stale when the run moved on since. */
export function summariesFor(runs: Run[]): Record<string, ConversationSummary> {
  const rows = db.conversationSummaries();
  const out: Record<string, ConversationSummary> = {};
  for (const r of runs) {
    const row = rows.get(r.sessionId);
    if (!row) continue;
    out[r.sessionId] = { sessionId: r.sessionId, status: row.status, about: row.about, latest: row.latest, needs: row.needs, generatedAt: row.generatedAt, error: row.error, stale: row.basis !== basisOf(r) };
  }
  return out;
}
