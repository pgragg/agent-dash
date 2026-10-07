import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DiagramKind } from "../shared/types.ts";

/** Only pictures an agent shows on purpose count; a screenshot it merely names does not. */

/** A diagram with its text, found in the log. */
export interface FoundText {
  kind: "mermaid" | "svg";
  title: string;
  source: string;
  hash: string;
  origin: string;
  at: string | null;
}

/** An image the agent embedded. The file is read later, outside the sync log parse. */
export interface FoundFile {
  kind: "file";
  title: string;
  /** Absolute. */
  path: string;
  /** As written, so the page can match an embed in a message to its diagram. */
  origin: string;
  at: string | null;
}

export type Found = FoundText | FoundFile;

/** A diagram or image bigger than this is more likely a mistake than a chart. */
export const MAX_TEXT = 200_000;
const MAX_IMAGE = 5_000_000;

export const sha1 = (data: string | Buffer) => createHash("sha1").update(data).digest("hex");

const FENCE = /^[ \t]*```[ \t]*mermaid[ \t]*\n([\s\S]*?)^[ \t]*```/gim;
/** The file that an agent writes a document in before it saves it to agent-dash. */
const DOCUMENT_DRAFT = /(^|\/)agent-dash-document-\d+\.md$/;
export const IMAGE = /!\[([^\]\n]*)\]\(<?([^)\s>]+)>?\)/g;
const IMAGE_EXT = /\.(png|svg|jpe?g|gif|webp)$/i;

/** "Flowchart" from "flowchart LR", "Sequence diagram" from "sequenceDiagram". */
function typeName(code: string): string {
  const first = code.split("\n").find((l) => l.trim() && !l.trim().startsWith("%%") && l.trim() !== "---")?.trim().split(/\s+/)[0] ?? "diagram";
  const words = first.replace(/-beta$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words === "graph" ? "Flowchart" : words.charAt(0).toUpperCase() + words.slice(1);
}

/** The diagram's own title, else the line just before the fence, else its type. */
export function mermaidTitle(code: string, before: string): string {
  // Front matter "title: X", a "title X" line, or "pie title X".
  const own = code.match(/^\s*title:\s*(.+)$/m)?.[1] ?? code.match(/^\s*(?:\w+\s+)?title\s+(.+)$/m)?.[1];
  if (own) return clip(own.replace(/^["']|["']$/g, ""));
  const lead = before
    .split("\n")
    // An image or a fence line is not a caption.
    .filter((l) => !/^\s*(!\[|```)/.test(l))
    .map((l) => l.replace(/[*_`#>]/g, "").trim())
    .filter(Boolean)
    .at(-1);
  // A long sentence is prose, not a caption.
  if (lead && lead.length <= 100) return clip(lead.replace(/:$/, ""));
  return typeName(code);
}

const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s.trim());

export function resolvePath(p: string, cwd: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : join(cwd || homedir(), p);
}

/** Mermaid fences and embedded local images in one assistant reply. */
export function findInReply(text: string, cwd: string, at: string | null): Found[] {
  const out: Found[] = [];
  for (const m of text.matchAll(FENCE)) {
    const code = m[1].trimEnd();
    if (!code.trim() || code.length > MAX_TEXT) continue;
    out.push({ kind: "mermaid", title: mermaidTitle(code, text.slice(0, m.index)), source: code, hash: sha1(code), origin: "reply", at });
  }
  for (const m of text.matchAll(IMAGE)) {
    const [, alt, p] = m;
    if (/^[a-z]+:/i.test(p) || !IMAGE_EXT.test(p)) continue; // A web image is not the agent's file.
    out.push({ kind: "file", title: clip(alt.trim() || p.split("/").pop()!), path: resolvePath(p, cwd), origin: p, at });
  }
  return out;
}

/** A written .mmd or .svg file, or the mermaid fences in a written markdown file. */
export function findInWrite(args: unknown, at: string | null): Found[] {
  const { path, content } = (args ?? {}) as { path?: unknown; content?: unknown };
  if (typeof path !== "string" || typeof content !== "string" || !content.trim() || content.length > MAX_TEXT) return [];
  const name = path.split("/").pop()!;
  if (/\.(mmd|mermaid)$/i.test(path)) {
    const own = mermaidTitle(content, "");
    return [{ kind: "mermaid", title: own === typeName(content) ? name : own, source: content, hash: sha1(content), origin: path, at }];
  }
  if (/\.svg$/i.test(path) && /<svg[\s>]/i.test(content)) return [{ kind: "svg", title: name, source: content, hash: sha1(content), origin: path, at }];
  // A document's draft: its diagrams show in the document.
  if (DOCUMENT_DRAFT.test(path)) return [];
  if (/\.(md|markdown|mdx)$/i.test(path)) return findInReply(content, "", at).flatMap((f) => (f.kind === "mermaid" ? [{ ...f, origin: path }] : []));
  return [];
}

/** The image type from its first bytes. The file name alone could hide any file. */
export function sniffImage(buf: Buffer): DiagramKind | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  const head = buf.subarray(0, 1024).toString("utf8");
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** Reads an embedded image. Null when it is missing, too big, or not an image. */
export async function loadImage(path: string): Promise<{ kind: DiagramKind; source: string; hash: string } | null> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > MAX_IMAGE) return null;
    const buf = await readFile(path);
    const kind = sniffImage(buf);
    if (!kind) return null;
    // SVG stays text, so the page can show its source.
    return { kind, source: kind === "svg" ? buf.toString("utf8") : buf.toString("base64"), hash: sha1(buf) };
  } catch {
    return null;
  }
}

export const MIME: Record<DiagramKind, string> = {
  mermaid: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
