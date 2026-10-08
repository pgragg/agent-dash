/**
 * The local Obsidian wiki: front matter, `[[wikilinks]]`, name resolution and search. Free of Node
 * and React, so the server, the page and the tests share one set of rules.
 */

/** One note in the list. `path` is relative to the wiki folder, with `/` and the `.md`. */
export interface WikiNoteMeta {
  path: string;
  title: string;
  /** The front matter `type`, such as `gotcha`; empty when the note has none. */
  type: string;
  tags: string[];
  aliases: string[];
  /** The folder of the note, `""` at the top of the wiki. */
  folder: string;
  /** The front matter `updated`, else the file's change time, as an ISO date. */
  updated: string | null;
  /** `stale` or `superseded`; null for a current note. */
  status: string | null;
}

export interface WikiHitLine {
  /** 1-based, in the whole file. */
  n: number;
  text: string;
}

export interface WikiHit extends WikiNoteMeta {
  score: number;
  lines: WikiHitLine[];
}

export interface WikiNote extends WikiNoteMeta {
  /** Every front matter field, as text, in file order. */
  fields: [string, string][];
  /** The markdown after the front matter. */
  body: string;
  backlinks: WikiNoteMeta[];
  /** For the Open in Obsidian link. */
  vault: string;
}

export interface WikiList {
  /** False when the wiki folder setting is empty. */
  configured: boolean;
  dir: string;
  notes: WikiNoteMeta[];
}

/** A note's text with its path, as the server's index holds it. */
export interface WikiSource {
  meta: WikiNoteMeta;
  body: string;
  /** The line of the file where the body starts, 1-based. */
  bodyLine: number;
}

const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, "$2");

/** `[a, b]` or `a, b` as a list. */
function listOf(v: string): string[] {
  const inner = v.trim().replace(/^\[(.*)\]$/, "$1");
  return inner
    .split(",")
    .map(unquote)
    .filter(Boolean);
}

/**
 * The YAML front matter that Obsidian notes start with. Only what notes use: `key: value`,
 * `key: [a, b]`, and a `- item` list under a bare `key:`. The rest of YAML stays as text.
 */
export function parseFrontMatter(text: string): { fields: [string, string][]; lists: Record<string, string[]>; body: string; bodyLine: number } {
  const lines = text.replace(/\r/g, "").split("\n");
  if (lines[0]?.trim() !== "---") return { fields: [], lists: {}, body: text.replace(/\r/g, ""), bodyLine: 1 };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { fields: [], lists: {}, body: text.replace(/\r/g, ""), bodyLine: 1 };
  const fields: [string, string][] = [];
  const lists: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of lines.slice(1, end)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && current) {
      (lists[current] ??= []).push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    current = kv[1];
    const value = kv[2].trim();
    if (value.startsWith("[")) lists[current] = listOf(value);
    fields.push([current, value.startsWith("[") ? lists[current].join(", ") : unquote(value)]);
  }
  for (const [key, items] of Object.entries(lists)) {
    const f = fields.find(([k]) => k === key);
    if (f && !f[1]) f[1] = items.join(", ");
  }
  const rest = lines.slice(end + 1);
  const blank = rest.findIndex((l) => l.trim() !== "");
  const skip = blank < 0 ? rest.length : blank;
  return { fields, lists, body: rest.slice(skip).join("\n"), bodyLine: end + 2 + skip };
}

/** The first `# Heading` of a body, else null. */
export function firstHeading(body: string): string | null {
  return body.match(/^#\s+(.+)$/m)?.[1].trim() ?? null;
}

/** The body without fenced code, so a `[[x]]` in a code sample or a mermaid chart is no link. */
export function withoutFences(body: string): string {
  return body.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
}

/** `[[Target]]`, `[[Target|label]]`, `[[Target#heading]]`, `![[embed]]`. */
export const WIKILINK = /(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

/** Image files that `![[x.png]]` embeds. */
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

/** The parts of one `[[...]]` or `![[...]]` token. */
export function wikiLinkParts(token: string): { embed: boolean; target: string; heading: string | null; label: string | null } {
  const m = new RegExp(WIKILINK.source).exec(token);
  if (!m) return { embed: false, target: token, heading: null, label: null };
  return { embed: m[1] === "!", target: m[2].trim(), heading: m[3] ? m[3].slice(1).trim() || null : null, label: m[4]?.trim() || null };
}

/** The targets of the `[[links]]` in a body, outside code. */
export function wikiLinkTargets(body: string): string[] {
  return [...withoutFences(body).matchAll(WIKILINK)].map((m) => m[2].trim());
}

const stem = (path: string): string => path.replace(/^.*\//, "").replace(/\.md$/i, "");
const norm = (s: string): string => s.trim().toLowerCase().replace(/\\/g, "/").replace(/\.md$/i, "");

/**
 * The note a ref names, the way Obsidian resolves a link: a path (with or without `.md`), then a
 * file name, then a title or an alias. Case does not matter. Null when no note has the name.
 */
export function resolveRef<T extends WikiNoteMeta>(notes: T[], ref: string): T | null {
  const r = norm(ref);
  if (!r) return null;
  return (
    notes.find((n) => norm(n.path) === r) ??
    notes.find((n) => norm(stem(n.path)) === r) ??
    notes.find((n) => norm(n.title) === r) ??
    notes.find((n) => n.aliases.some((a) => norm(a) === r)) ??
    null
  );
}

/** Every name that a link can use for a note: its path, file name, title and aliases, lower case. */
export function namesOf(n: WikiNoteMeta): string[] {
  return [norm(n.path), norm(stem(n.path)), norm(n.title), ...n.aliases.map(norm)];
}

const MAX_LINES = 3;

/**
 * Notes that hold every word of the query, best first. A word in the title counts most, then in
 * a tag, alias, type or path, then each time it shows in the text. The whole query in the title
 * counts more again, so an exact title comes first.
 */
export function searchWiki(sources: WikiSource[], query: string): WikiHit[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: WikiHit[] = [];
  for (const s of sources) {
    const title = s.meta.title.toLowerCase();
    const labels = [...s.meta.tags, ...s.meta.aliases, s.meta.type, s.meta.path].join(" ").toLowerCase();
    const body = s.body.toLowerCase();
    if (!words.every((w) => title.includes(w) || labels.includes(w) || body.includes(w))) continue;
    let score = 0;
    for (const w of words) {
      if (title.includes(w)) score += 10;
      if (labels.includes(w)) score += 4;
      score += Math.min(10, body.split(w).length - 1);
    }
    if (title === q) score += 100;
    else if (title.includes(q)) score += 30;
    else if (words.length > 1 && body.includes(q)) score += 15;
    const lines: WikiHitLine[] = [];
    const bodyLines = s.body.split("\n");
    for (let i = 0; i < bodyLines.length && lines.length < MAX_LINES; i++) {
      const l = bodyLines[i].toLowerCase();
      if (words.some((w) => l.includes(w))) lines.push({ n: s.bodyLine + i, text: bodyLines[i].trim().slice(0, 220) });
    }
    hits.push({ ...s.meta, score, lines });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}
