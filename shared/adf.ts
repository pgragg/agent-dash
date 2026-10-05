/**
 * Jira's REST API v3 returns rich text as Atlassian Document Format (ADF) JSON. This turns it
 * into the small markdown subset that the page's `Markdown` component renders.
 * A node type that is not known here keeps its text, so nothing in a ticket goes missing.
 */
export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
  content?: AdfNode[];
}

const BLOCKS = new Set(["paragraph", "heading", "bulletList", "orderedList", "codeBlock", "blockquote", "rule", "table", "panel", "mediaSingle", "mediaGroup", "expand", "nestedExpand", "blockCard"]);

function marked(node: AdfNode): string {
  let out = node.text ?? "";
  if (!out) return "";
  const marks = node.marks ?? [];
  // Code wins: inside backticks the other marks would show as literal characters.
  if (marks.some((m) => m.type === "code")) return `\`${out.replace(/`/g, "'")}\``;
  // Spaces stay outside the markers: "**Risk: **" is not bold in markdown.
  const [, lead, core, trail] = out.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  if (core) {
    let inner = core;
    for (const m of marks) {
      if (m.type === "strong") inner = `**${inner}**`;
      else if (m.type === "em") inner = `*${inner}*`;
      else if (m.type === "strike") inner = `~~${inner}~~`;
    }
    out = `${lead}${inner}${trail}`;
  }
  const href: string | undefined = marks.find((m) => m.type === "link")?.attrs?.href;
  if (href) {
    // A link whose text is its URL reads best bare; a URL with ")" or spaces breaks [label](url).
    if (out === href) return href;
    return /^https?:\/\/[^)\s]+$/.test(href) ? `[${out}](${href})` : `${out} (${href})`;
  }
  return out;
}

/** One line of inline content. */
function inlineText(nodes: AdfNode[] = []): string {
  return nodes.map(inlineNode).join("");
}

function inlineNode(n: AdfNode): string {
  switch (n.type) {
    case "text":
      return marked(n);
    case "hardBreak":
      return "\n";
    case "mention":
      return `@${String(n.attrs?.text ?? "someone").replace(/^@/, "")}`;
    case "emoji":
      return n.attrs?.text ?? n.attrs?.shortName ?? "";
    case "inlineCard":
      return n.attrs?.url ?? "";
    case "status":
      return n.attrs?.text ? `[${n.attrs.text}]` : "";
    case "date": {
      const ts = Number(n.attrs?.timestamp);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : "";
    }
    default:
      return n.text ?? inlineText(n.content);
  }
}

function listItems(n: AdfNode, indent: string, ordered: boolean): string {
  const start = Number(n.attrs?.order ?? 1);
  return (n.content ?? [])
    .map((item, i) => {
      const marker = ordered ? `${start + i}. ` : "- ";
      const parts = (item.content ?? []).map((c) => (c.type === "bulletList" || c.type === "orderedList" ? `\n${block(c, `${indent}  `)}` : ` ${block(c, indent).replace(/\n/g, " ")}`));
      return `${indent}${marker}${parts.join("").trim()}`;
    })
    .join("\n");
}

function block(n: AdfNode, indent = ""): string {
  switch (n.type) {
    case "paragraph":
      return inlineText(n.content);
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, Number(n.attrs?.level ?? 3))))} ${inlineText(n.content).replace(/\n/g, " ")}`;
    case "bulletList":
      return listItems(n, indent, false);
    case "orderedList":
      return listItems(n, indent, true);
    case "codeBlock":
      return `\`\`\`${n.attrs?.language ?? ""}\n${(n.content ?? []).map((c) => c.text ?? "").join("")}\n\`\`\``;
    case "blockquote":
      return blocks(n.content)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return (n.content ?? []).map((row) => `| ${(row.content ?? []).map((cell) => blocks(cell.content).replace(/\n+/g, " ").replace(/\|/g, "/")).join(" | ")} |`).join("\n");
    case "blockCard":
      return n.attrs?.url ?? "";
    default:
      // panel, expand, and anything newer: keep the children, or the text.
      if (n.content?.some((c) => BLOCKS.has(c.type))) return blocks(n.content);
      return inlineNode(n);
  }
}

function blocks(nodes: AdfNode[] = []): string {
  return nodes
    .map((n) => block(n))
    .filter((s) => s.trim())
    .join("\n\n");
}

/** A whole ADF document (or a plain string, which older fields can be) as markdown. */
export function adfToMarkdown(doc: AdfNode | string | null | undefined): string {
  if (!doc) return "";
  if (typeof doc === "string") return doc;
  return (doc.type === "doc" ? blocks(doc.content) : block(doc)).trim();
}
