import type { SlackQuote } from "./types.ts";

const PERMALINK = /https:\/\/[\w.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)[^\s)<>\]]*/g;

/** Channel and message id: the same message has other hosts and query strings in other links. */
function messageId(url: string): string | null {
  const m = new RegExp(PERMALINK.source).exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The Slack messages that a summary links to, in the order it links to them, once each. */
export function citedSlack(summary: string, hits: SlackQuote[]): SlackQuote[] {
  const byId = new Map<string, SlackQuote>();
  for (const h of hits) {
    const id = messageId(h.permalink ?? "");
    if (id && !byId.has(id)) byId.set(id, h);
  }
  const out: SlackQuote[] = [];
  const seen = new Set<string>();
  for (const [url] of summary.matchAll(PERMALINK)) {
    const id = messageId(url)!;
    const hit = byId.get(id);
    if (hit && !seen.has(id)) {
      seen.add(id);
      out.push(hit);
    }
  }
  return out;
}

/** The JSON lines that slack-search.ts appends; a broken line is skipped. */
export function parseSlackHits(jsonl: string): SlackQuote[] {
  const out: SlackQuote[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const h = JSON.parse(line);
      if (typeof h.permalink === "string") out.push({ permalink: h.permalink, channel: String(h.channel ?? ""), user: String(h.user ?? ""), ts: String(h.ts ?? ""), text: String(h.text ?? "") });
    } catch {
      // A run killed mid-write leaves half a line.
    }
  }
  return out;
}

/**
 * The matches in the answer of the Slack MCP tool `slack_search_public_and_private`: markdown,
 * one `### Result n of m` block each, in JSON as `results`. A block with no permalink is skipped.
 */
export function parseSlackSearch(answer: string): SlackQuote[] {
  let md = answer;
  try {
    md = String(JSON.parse(answer).results ?? "");
  } catch {
    // An answer that is not JSON is the markdown itself.
  }
  const out: SlackQuote[] = [];
  for (const block of md.split(/^### Result \d+ of \d+$/m).slice(1)) {
    const field = (name: string) => block.match(new RegExp(`^${name}: ?(.*)$`, "m"))?.[1].trim() ?? "";
    const permalink = field("Permalink").match(/\((https:\/\/[^)\s]+)\)/)?.[1];
    if (!permalink) continue;
    const channel = field("Channel").replace(/\s*\(ID: [^)]*\)$/, "").replace(/^#/, "");
    const user = field("From").replace(/\s*\(ID: [^)]*\).*$/, "").replace(/\s*<[^>]*>$/, "");
    // The text runs to the context lists or the block's closing rule.
    const text = (block.split(/^Text: ?$/m)[1] ?? "").split(/^(?:Context before:|Context after:|---)\s*$/m)[0].trim();
    out.push({ permalink, channel, user, ts: field("Message_ts"), text });
  }
  return out;
}
