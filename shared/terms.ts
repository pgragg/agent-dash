/**
 * Domain marks: a document names each domain noun in an inline code span with a kind prefix, and
 * declares the nouns once in a ```domain fence (JSON). agent-dash colors each mark by its kind, shows
 * a hover card from the registry, draws a context's sections with a colored rail, and renders the
 * fence as the page's legend. Other markdown viewers show the marks as plain code.
 */
export const TERM_KINDS = {
  rec: "Stored record",
  fn: "Code method",
  obj: "Data object",
  rule: "Rule",
  svc: "Service",
  ctx: "Bounded context",
  ext: "External system or actor",
} as const;

export type TermKind = keyof typeof TERM_KINDS;

export const TERM_HELP: Record<TermKind, string> = {
  rec: "A row, column, key or file in a store. Its service and store show in front of it",
  fn: "A function, server action, route handler, or a component that does a check",
  obj: "A type, token, config entry or file shape that code reads. Not a stored row",
  rule: "An invariant of the domain. Other text refers to it by its ID",
  svc: "A deployable unit, or a build job, that owns its stores",
  ctx: "A part of the domain where each word has one meaning",
  ext: "A person, or a system that is not ours. We cannot change its model",
};

const TERM = /^(rec|fn|obj|rule|svc|ctx|ext):(\S.*)$/;

export function domainTerm(code: string): { kind: TermKind; name: string } | null {
  const m = code.match(TERM);
  return m ? { kind: m[1] as TermKind, name: m[2] } : null;
}

export interface Term {
  kind: Exclude<TermKind, "svc" | "ctx">;
  /** A rule's short name. */
  name?: string;
  about?: string;
  service?: string;
  /** A key of the service's `stores`. A stored record needs it. */
  store?: string;
  context?: string;
  /** The term that this one is derived from. A copy draws with a dashed border. */
  copyOf?: string;
  /** How the copy follows its source, and how late it can be. */
  sync?: string;
  /** An identity key: it joins records across contexts. */
  key?: boolean;
  /** Where it is in the code: `path:line`. */
  code?: string;
}

export interface Registry {
  contexts: Record<string, { name: string; about?: string }>;
  services: Record<string, { name: string; about?: string; stores?: Record<string, string> }>;
  terms: Record<string, Term>;
}

export const DOMAIN_FENCE = /^```domain\s*$/;

/** The registry in the document's ```domain fence, or the reason it is not valid. */
export function readRegistry(markdown: string): { registry: Registry | null; error?: string } {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => DOMAIN_FENCE.test(l));
  if (start < 0) return { registry: null };
  const end = lines.findIndex((l, i) => i > start && l.startsWith("```"));
  if (end < 0) return { registry: null, error: "the domain fence has no end" };
  return parseRegistry(lines.slice(start + 1, end).join("\n"));
}

export function parseRegistry(json: string): { registry: Registry | null; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { registry: null, error: "the domain fence is not valid JSON: " + (err as Error).message };
  }
  const r = (raw ?? {}) as Partial<Registry>;
  if (typeof r !== "object" || Array.isArray(r)) return { registry: null, error: "the domain fence must hold one JSON object" };
  return { registry: { contexts: r.contexts ?? {}, services: r.services ?? {}, terms: r.terms ?? {} } };
}

/** The entry for a name, or for the nearest namespace above it: `Table.column` falls back to `Table`. */
export function lookup(registry: Registry, name: string): { base: string; term: Term } | null {
  for (let n = name; n; n = n.includes(".") ? n.slice(0, n.lastIndexOf(".")) : "") {
    const term = registry.terms[n];
    if (term) return { base: n, term };
  }
  return null;
}

/** Each context's color, in the order that the registry declares them. */
export const CONTEXT_PALETTE = ["violet", "olive", "sienna", "slate", "plum", "moss"] as const;

export function contextTone(registry: Registry, id: string): string | undefined {
  const i = Object.keys(registry.contexts).indexOf(id);
  return i < 0 ? undefined : CONTEXT_PALETTE[i % CONTEXT_PALETTE.length];
}

// ---- lint ----------------------------------------------------------------------------

export interface LintIssue {
  level: "error" | "warning";
  line: number;
  message: string;
}

/** Every inline code span outside a fence, with its line number. */
function codeSpans(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fence = false;
  markdown.replace(/\r/g, "").split("\n").forEach((l, i) => {
    if (l.startsWith("```")) {
      fence = !fence;
      return;
    }
    if (fence) return;
    for (const m of l.matchAll(/`([^`\n]+)`/g)) out.push({ line: i + 1, text: m[1] });
  });
  return out;
}

export function lintDomain(markdown: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (level: LintIssue["level"], line: number, message: string) => issues.push({ level, line, message });
  const { registry, error } = readRegistry(markdown);
  if (error) return [{ level: "error", line: 0, message: error }];
  if (!registry) return [{ level: "error", line: 0, message: "the document has no domain fence" }];

  for (const [name, t] of Object.entries(registry.terms)) {
    if (!["rec", "fn", "obj", "rule", "ext"].includes(t.kind)) add("error", 0, `term ${name}: kind must be rec, fn, obj, rule or ext`);
    if (t.service && !registry.services[t.service]) add("error", 0, `term ${name}: no service "${t.service}"`);
    if (t.context && !registry.contexts[t.context]) add("error", 0, `term ${name}: no context "${t.context}"`);
    if (t.kind === "rec" && !(t.service && t.store)) add("error", 0, `term ${name}: a stored record needs a service and a store`);
    if (t.store && t.service && !registry.services[t.service]?.stores?.[t.store]) add("error", 0, `term ${name}: service ${t.service} has no store "${t.store}"`);
    if (t.copyOf && !lookup(registry, t.copyOf)) add("error", 0, `term ${name}: copyOf "${t.copyOf}" is not a term`);
    if (t.kind === "rule" && !t.name) add("error", 0, `rule ${name}: a rule needs a name`);
    if (!t.about) add("warning", 0, `term ${name}: no "about", so its hover card is thin`);
  }

  const used = new Set<string>();
  const names = new Set(Object.keys(registry.terms));
  for (const { line, text } of codeSpans(markdown)) {
    const mark = domainTerm(text);
    if (!mark) {
      const hit = lookup(registry, text.replace(/\(.*$/, ""));
      if (hit) add("warning", line, `\`${text}\` is a registered term with no mark: write \`${hit.term.kind}:${text}\``);
      continue;
    }
    if (mark.kind === "svc") {
      if (!registry.services[mark.name]) add("error", line, `no service "${mark.name}"`);
      used.add(`svc:${mark.name}`);
      continue;
    }
    if (mark.kind === "ctx") {
      if (!registry.contexts[mark.name]) add("error", line, `no context "${mark.name}"`);
      used.add(`ctx:${mark.name}`);
      continue;
    }
    const hit = lookup(registry, mark.name);
    if (!hit) {
      add("error", line, `\`${text}\` is not in the registry`);
      continue;
    }
    used.add(hit.base);
    if (hit.term.kind !== mark.kind) add("error", line, `\`${text}\` is registered as ${hit.term.kind}, not ${mark.kind}`);
  }
  for (const name of names) if (!used.has(name) && !Object.values(registry.terms).some((t) => t.copyOf === name)) add("warning", 0, `term ${name} is registered but never marked`);
  for (const id of Object.keys(registry.contexts)) if (!used.has(`ctx:${id}`)) add("warning", 0, `context ${id} is never marked: put \`ctx:${id}\` in the heading of its sections`);
  return issues;
}
