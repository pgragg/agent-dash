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
