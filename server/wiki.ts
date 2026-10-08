import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { firstHeading, parseFrontMatter, resolveRef, searchWiki, wikiLinkTargets, type WikiHit, type WikiNote, type WikiNoteMeta, type WikiSource } from "../shared/wiki.ts";

/**
 * Reads the local Obsidian wiki for the Wiki view. Read-only: nothing here writes to the folder.
 * Every path from a request is checked to stay inside the folder, also through a symlink.
 */

export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

interface Indexed extends WikiSource {
  mtimeMs: number;
  links: string[];
}

/** One cache per folder: a note is read again only when its file changes. */
const caches = new Map<string, Map<string, Indexed>>();

/** Obsidian's template folder, from `.obsidian/templates.json`; templates are not notes. */
function templateFolder(dir: string): string | null {
  try {
    const folder = JSON.parse(readFileSync(join(dir, ".obsidian", "templates.json"), "utf8")).folder;
    return typeof folder === "string" && folder.trim() ? folder.trim().replace(/^\/|\/$/g, "") : null;
  } catch {
    return null;
  }
}

/** Every file under the folder, relative, with `/`. Dot folders (`.obsidian`, `.git`, `.trash`) and the template folder are skipped. */
function walk(dir: string, skip: string | null): { rel: string; mtimeMs: number }[] {
  const out: { rel: string; mtimeMs: number }[] = [];
  const visit = (abs: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (r !== skip) visit(join(abs, e.name), r);
      } else if (e.isFile()) {
        try {
          out.push({ rel: r, mtimeMs: statSync(join(abs, e.name)).mtimeMs });
        } catch {
          // Gone between the read and the stat.
        }
      }
    }
  };
  visit(dir, "");
  return out;
}

function metaOf(rel: string, text: string, mtimeMs: number): Indexed {
  const fm = parseFrontMatter(text);
  const field = (k: string) => fm.fields.find(([key]) => key === k)?.[1] ?? "";
  const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const meta: WikiNoteMeta = {
    path: rel,
    title: field("title") || firstHeading(fm.body) || basename(rel, ".md"),
    type: field("type"),
    tags: fm.lists.tags ?? (field("tags") ? field("tags").split(/[,\s]+/).filter(Boolean) : []),
    aliases: fm.lists.aliases ?? (field("aliases") ? [field("aliases")] : []),
    folder,
    updated: field("updated") || new Date(mtimeMs).toISOString().slice(0, 10),
    // A current note is the default; only stale or superseded notes stand out.
    status: field("status") && field("status") !== "current" ? field("status") : null,
  };
  return { meta, body: fm.body, bodyLine: fm.bodyLine, mtimeMs, links: wikiLinkTargets(fm.body) };
}

/** The notes of the folder, from the cache where the file did not change. */
export function indexWiki(dir: string): Indexed[] {
  const cache = caches.get(dir) ?? new Map<string, Indexed>();
  caches.set(dir, cache);
  const seen = new Set<string>();
  const out: Indexed[] = [];
  for (const f of walk(dir, templateFolder(dir))) {
    if (extname(f.rel).toLowerCase() !== ".md") continue;
    seen.add(f.rel);
    let n = cache.get(f.rel);
    if (!n || n.mtimeMs !== f.mtimeMs) {
      try {
        n = metaOf(f.rel, readFileSync(join(dir, f.rel), "utf8"), f.mtimeMs);
      } catch {
        continue;
      }
      cache.set(f.rel, n);
    }
    out.push(n);
  }
  for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  return out.sort((a, b) => a.meta.path.localeCompare(b.meta.path));
}

export function listWiki(dir: string): WikiNoteMeta[] {
  return indexWiki(dir).map((n) => n.meta);
}

export function searchWikiDir(dir: string, query: string): WikiHit[] {
  return searchWiki(indexWiki(dir), query);
}

/** One note by a path, file name, title or alias, with the notes that link to it. Null when none matches. */
export function readWikiNote(dir: string, ref: string): WikiNote | null {
  if (!isSafeRef(ref)) return null;
  const all = indexWiki(dir);
  const n = resolveRef(
    all.map((x) => x.meta),
    ref,
  );
  if (!n) return null;
  const note = all.find((x) => x.meta.path === n.path)!;
  const metas = all.map((x) => x.meta);
  const backlinks = all.filter((x) => x.meta.path !== n.path && x.links.some((l) => resolveRef(metas, l)?.path === n.path)).map((x) => x.meta);
  return {
    ...n,
    fields: parseFrontMatter(readFileSync(join(dir, n.path), "utf8")).fields,
    body: note.body,
    backlinks,
    vault: basename(dir),
  };
}

/** No absolute path, no `..`, no NUL: a ref names something inside the folder or nothing. */
export function isSafeRef(ref: string): boolean {
  if (!ref || ref.length > 500 || ref.includes("\0")) return false;
  if (ref.startsWith("/") || ref.startsWith("\\") || /^[a-z]:/i.test(ref)) return false;
  return !ref.split(/[\\/]/).includes("..");
}

/**
 * An image in the wiki, by its path or, as `![[x.png]]` does, by its file name anywhere in the
 * folder. Null for anything else, and for a path that leaves the folder through a symlink.
 */
export function wikiFile(dir: string, ref: string): { abs: string; mime: string } | null {
  if (!isSafeRef(ref)) return null;
  const mime = IMAGE_MIME[extname(ref).toLowerCase()];
  if (!mime) return null;
  const files = walk(dir, null).map((f) => f.rel);
  const r = ref.replace(/\\/g, "/").toLowerCase();
  const rel = files.find((f) => f.toLowerCase() === r) ?? files.find((f) => basename(f).toLowerCase() === basename(r));
  if (!rel) return null;
  try {
    const root = realpathSync(dir);
    const abs = realpathSync(join(dir, rel));
    if (abs !== root && !abs.startsWith(root + sep)) return null;
    if (relative(root, abs).startsWith("..")) return null;
    return { abs, mime };
  } catch {
    return null;
  }
}
