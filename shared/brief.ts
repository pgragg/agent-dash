/**
 * A ticket brief: a fixed-shape, visual-first page that gets an engineer with no context on a repo
 * up to speed on one ticket in about five minutes. The agent writes this JSON spec; the renderer
 * owns the layout, and the lint below refuses a spec that a reader would trip over.
 * docs/ticket-brief/GUIDE.md says how to write one. Every field is in docs/ticket-brief/SPEC.md.
 */

export const BRIEF_SCHEMA = "ticket-brief/1";

export type How = "verified" | "read" | "said" | "inferred";
export const BADGE: Record<How, string> = { verified: "V", read: "R", said: "S", inferred: "I" };
export const HOW_MEANS: Record<How, string> = {
  verified: "ran it and saw the result",
  read: "seen in code, config, docs or a dashboard",
  said: "a person said it in a ticket, PR, wiki or chat",
  inferred: "reasoned, not confirmed",
};

export type Size = "S" | "M" | "L";
export type NodeKind = "actor" | "service" | "store" | "external";
export type Tone = "normal" | "bad" | "new" | "dashed";

export interface Fact { id: string; text: string; source: string; how: How; as_of?: string }
export interface Link { label: string; url: string }
export interface Shift { what: string; before: string; after: string }
export interface Stat { value: string; label: string; fact?: string }
export interface HeadsUp { title: string; body: string; ticket_says?: string; facts?: string[] }

/** A box on the map. `col` and `row` are grid cells, the same in every view, so the eye sees what moves. */
export interface MapNode { id: string; label: string; sub?: string; col: number; row: number; kind?: NodeKind }
export interface MapEdge { from: string; to: string; label?: string; tone?: Tone }
export interface Pin { node: string; text: string; fact?: string }
/**
 * One state of the map. A node in `hide` is not drawn. A node that the previous view hid shows as
 * new, and one that the previous view showed and this one hides shows once more, ghosted, as removed.
 */
export interface MapView { id: string; label: string; caption?: string; hide?: string[]; changed?: string[]; notes?: Record<string, string>; edges: MapEdge[]; pins?: Pin[] }
export interface SystemMap { heading: string; nodes: MapNode[]; views: MapView[] }

export interface FlowStep { from: string; to: string; label: string; tone?: Tone; note?: string }
export interface Flow { heading: string; lanes: { id: string; label: string }[]; steps: FlowStep[] }

export interface DoneItem { text: string; verify: string; fact?: string }
export type AcVerdict = "ok" | "change" | "drop" | "add";
export interface AcReview { ac: string; verdict: AcVerdict; note?: string }
export interface Done { heading?: string; items: DoneItem[]; ac_review?: AcReview[] }

export type StepState = "done" | "now" | "next";
export interface PathStep { title: string; who: string; detail?: string; date?: string; gate?: string; undo?: string; human?: boolean; state?: StepState }
export interface PathSection { heading?: string; steps: PathStep[] }

/** A cell starts with "+ " (good), "~ " (mixed) or "- " (bad), then a few words. */
export interface DecisionOption { name: string; cells: string[]; recommended?: boolean }
export interface Decision { question: string; decider: string; criteria: string[]; options: DecisionOption[]; why: string; facts?: string[] }
export interface MinorDecision { question: string; call: string; decider?: string }
export interface Decisions { heading?: string; major: Decision[]; minor?: MinorDecision[] }

export interface Person { who: string; before: string; after: string }
export interface People { heading?: string; rows: Person[] }

export type PrState = "draft" | "open" | "merged" | "closed";
export type Actor = "agent" | "human" | "either";
export interface Repo { repo: string; url?: string; why: string; paths: string[]; pr?: { label: string; url: string; state: PrState }; who: Actor; human_only?: string }
export interface Work { heading?: string; first_move: string; repos: Repo[] }

export interface Risk { text: string; mitigation?: string; fact?: string }
export interface Question { q: string; owner: string }
export interface Risks { heading?: string; items: Risk[]; questions?: Question[] }

export interface Brief {
  schema: typeof BRIEF_SCHEMA;
  key: string;
  title: string;
  size: Size;
  /** One sentence: <verb> <thing> so that <why>. */
  ask: string;
  /** YYYY-MM-DD: the day the facts were last checked. */
  verified_on: string;
  links?: Link[];
  glance?: { shifts: Shift[]; numbers?: Stat[]; headsups?: HeadsUp[] };
  system?: SystemMap;
  flow?: Flow;
  done?: Done;
  path?: PathSection;
  decisions?: Decisions;
  people?: People;
  work?: Work;
  risks?: Risks;
  facts: Fact[];
  glossary?: { term: string; means: string }[];
}

/** The section headings when the spec gives none. A system map and a flow must give a claim. */
export const DEFAULT_HEADING = {
  done: "Done looks like",
  path: "The path",
  decisions: "Decisions",
  people: "Who notices",
  work: "Where the work is",
  risks: "Risks",
};

/** The words a reader sees without opening anything. The ledger and the collapsed parts are free. */
export const WORD_BUDGET: Record<Size, number> = { S: 900, M: 1300, L: 1600 };

export const CAPS = { shifts: 6, numbers: 3, headsups: 4, nodesPerView: 8, pinsPerView: 3, views: 4, flowLanes: 6, flowSteps: 12, done: 8, path: 7, major: 3, people: 5, repos: 6, risksShown: 3 };

// ---- parse ---------------------------------------------------------------------------------

/** The spec in a document body, or null for a markdown document. */
export function parseBrief(body: string): Brief | null {
  if (!body.trimStart().startsWith("{")) return null;
  try {
    const v = JSON.parse(body) as { schema?: unknown };
    return v && typeof v === "object" && v.schema === BRIEF_SCHEMA ? (v as Brief) : null;
  } catch {
    return null;
  }
}

// ---- map geometry: the renderer and the lint use the same numbers --------------------------

export const GRID = { cellW: 220, cellH: 118, nodeW: 164, nodeH: 64, pad: 14 };

export interface Box { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

export function nodeBox(n: Pick<MapNode, "col" | "row">): Box {
  return { x: GRID.pad + n.col * GRID.cellW + (GRID.cellW - GRID.nodeW) / 2, y: GRID.pad + n.row * GRID.cellH + (GRID.cellH - GRID.nodeH) / 2, w: GRID.nodeW, h: GRID.nodeH };
}

/** The canvas fits every node of every view, so switching views never moves a box. */
export function canvasSize(nodes: Pick<MapNode, "col" | "row">[]): { w: number; h: number } {
  const cols = Math.max(0, ...nodes.map((n) => n.col)) + 1;
  const rows = Math.max(0, ...nodes.map((n) => n.row)) + 1;
  return { w: GRID.pad * 2 + cols * GRID.cellW, h: GRID.pad * 2 + rows * GRID.cellH };
}

const center = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Where the ray from the box's center towards `toward` leaves the box, plus a small gap. */
function exitPoint(b: Box, toward: Pt, gap = 4): Pt {
  const c = center(b);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const t = Math.min(dx ? (b.w / 2 + gap) / Math.abs(dx) : Infinity, dy ? (b.h / 2 + gap) / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function inBox(p: Pt, b: Box, margin = 6): boolean {
  return p.x > b.x - margin && p.x < b.x + b.w + margin && p.y > b.y - margin && p.y < b.y + b.h + margin;
}

export interface Route { start: Pt; end: Pt; control: Pt | null; label: Pt; clear: boolean }

function quad(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

/**
 * A straight line between two boxes; when it would cross another box, a curve that bows around it.
 * `clear` is false when no curve misses every box: the lint warns, and the agent moves a node.
 * `bend` offsets a curve, so the two edges of an A↔B pair do not draw on top of each other.
 */
export function routeEdge(from: Box, to: Box, others: Box[], bend = 0): Route {
  const cf = center(from);
  const ct = center(to);
  const hits = (pts: Pt[]) => pts.some((p) => others.some((o) => inBox(p, o)));
  const samples = (a: Pt, c: Pt | null, b: Pt) => Array.from({ length: 19 }, (_, i) => (c ? quad(a, c, b, (i + 1) / 20) : { x: a.x + ((b.x - a.x) * (i + 1)) / 20, y: a.y + ((b.y - a.y) * (i + 1)) / 20 }));
  const dx = ct.x - cf.x;
  const dy = ct.y - cf.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const tries = bend ? [bend, bend * 2] : [0, 0.32, -0.32, 0.55, -0.55];
  for (const k of tries) {
    const mid = { x: (cf.x + ct.x) / 2, y: (cf.y + ct.y) / 2 };
    const control = k ? { x: mid.x + nx * len * k, y: mid.y + ny * len * k } : null;
    const start = exitPoint(from, control ?? ct);
    const end = exitPoint(to, control ?? cf, 7);
    if (!hits(samples(start, control, end))) return { start, end, control, label: control ? quad(start, control, end, 0.5) : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, clear: true };
  }
  const start = exitPoint(from, ct);
  const end = exitPoint(to, cf, 7);
  return { start, end, control: null, label: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, clear: false };
}

/** About 6.8 px per character of the 12 px edge-label font: close enough to size its background. */
export const labelWidth = (s: string) => s.length * 6.8 + 10;
const LABEL_LINE = 14.5;

function overlaps(a: Box, b: Box, margin = 2): boolean {
  return a.x < b.x + b.w + margin && a.x + a.w > b.x - margin && a.y < b.y + b.h + margin && a.y + a.h > b.y - margin;
}

/** A label split in two lines of about equal length, at the space nearest the middle. */
function twoLines(s: string): string[] {
  const spaces = [...s.matchAll(/ /g)].map((m) => m.index);
  if (!spaces.length) return [s];
  const cut = spaces.reduce((best, i) => (Math.abs(i - s.length / 2) < Math.abs(best - s.length / 2) ? i : best));
  return [s.slice(0, cut), s.slice(cut + 1)];
}

export interface LabelPlace { lines: string[]; box: Box; clear: boolean }

/**
 * Where an edge's label goes: on its line, on one line or two, then nudged a little off the line.
 * `clear` is false when every place covers a box: the lint warns, and the agent shortens the label
 * or moves a node, because a label that floats over a box is read as part of that box.
 */
export function placeLabel(label: string, at: Pt, boxes: Box[]): LabelPlace {
  const shapes = [[label], twoLines(label)].filter((l, i) => i === 0 || l.length === 2);
  const nudges: Pt[] = [{ x: 0, y: 0 }, { x: 0, y: -14 }, { x: 0, y: 14 }, { x: 16, y: 0 }, { x: -16, y: 0 }];
  let first: LabelPlace | null = null;
  for (const lines of shapes) {
    const w = Math.max(...lines.map(labelWidth));
    const h = lines.length * LABEL_LINE + 3;
    for (const n of nudges) {
      const box = { x: at.x + n.x - w / 2, y: at.y + n.y - h / 2, w, h };
      const place = { lines, box, clear: !boxes.some((b) => overlaps(box, b)) };
      first ??= place;
      if (place.clear) return place;
    }
  }
  return { ...first!, clear: false };
}

export type NodeState = "same" | "new" | "changed" | "gone";

/** Each node's state in each view: what the reader sees appear, change and go. Hidden nodes are absent. */
export function viewStates(map: SystemMap): Map<string, NodeState>[] {
  const out: Map<string, NodeState>[] = [];
  let prev: Set<string> | null = null;
  for (const v of map.views ?? []) {
    const hidden = new Set(v.hide ?? []);
    const shown = new Set(map.nodes.filter((n) => !hidden.has(n.id)).map((n) => n.id));
    const states = new Map<string, NodeState>();
    for (const n of map.nodes) {
      if (shown.has(n.id)) states.set(n.id, prev && !prev.has(n.id) ? "new" : v.changed?.includes(n.id) ? "changed" : "same");
      else if (prev?.has(n.id)) states.set(n.id, "gone");
    }
    out.push(states);
    prev = shown;
  }
  return out;
}

// ---- lint ----------------------------------------------------------------------------------

export interface Lint { errors: string[]; warnings: string[]; words: number }

const GENERIC_HEADINGS = /^(current )?(architecture|overview|background|context|summary|details|system|diagram|flow|current state|today|how it works)$/i;
const NARRATION = /\b(I|we) (tested|ran|checked|found|looked|verified|confirmed|noticed|saw)\b/;
const SECRETS: [RegExp, string][] = [
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, "a JWT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bfern_[A-Za-z0-9]{16,}/, "a Fern token"],
  [/\bNRAK-[A-Z0-9]{20,}/, "a New Relic key"],
];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const words = (s: string | undefined) => (s ? (s.match(/\S+/g) ?? []).length : 0);

/** The text that a reader sees without opening the ledger or a collapsed list. */
export function visibleText(b: Brief): string[] {
  const t: (string | undefined)[] = [b.title, b.ask];
  for (const s of b.glance?.shifts ?? []) t.push(s.what, s.before, s.after);
  for (const s of b.glance?.numbers ?? []) t.push(s.value, s.label);
  for (const h of b.glance?.headsups ?? []) t.push(h.title, h.body, h.ticket_says);
  if (b.system) {
    t.push(b.system.heading);
    for (const n of b.system.nodes ?? []) t.push(n.label, n.sub);
    for (const v of b.system.views ?? []) {
      t.push(v.label, v.caption, ...Object.values(v.notes ?? {}));
      for (const e of v.edges ?? []) t.push(e.label);
      for (const p of v.pins ?? []) t.push(p.text);
    }
  }
  if (b.flow) {
    t.push(b.flow.heading, ...(b.flow.lanes ?? []).map((l) => l.label));
    for (const s of b.flow.steps ?? []) t.push(s.label, s.note);
  }
  if (b.done) {
    t.push(b.done.heading);
    for (const d of b.done.items ?? []) t.push(d.text, d.verify);
    for (const a of b.done.ac_review ?? []) t.push(a.ac, a.note);
  }
  if (b.path) {
    t.push(b.path.heading);
    for (const s of b.path.steps ?? []) t.push(s.title, s.who, s.detail, s.date, s.gate, s.undo);
  }
  if (b.decisions) {
    t.push(b.decisions.heading);
    for (const d of b.decisions.major ?? []) t.push(d.question, d.decider, d.why, ...(d.criteria ?? []), ...(d.options ?? []).flatMap((o) => [o.name, ...(o.cells ?? [])]));
  }
  if (b.people) {
    t.push(b.people.heading);
    for (const p of b.people.rows ?? []) t.push(p.who, p.before, p.after);
  }
  if (b.work) {
    t.push(b.work.heading, b.work.first_move);
    for (const r of b.work.repos ?? []) t.push(r.repo, r.why, r.human_only, r.pr?.label, ...(r.paths ?? []));
  }
  if (b.risks) {
    t.push(b.risks.heading);
    for (const r of (b.risks.items ?? []).slice(0, CAPS.risksShown)) t.push(r.text, r.mitigation);
    for (const q of b.risks.questions ?? []) t.push(q.q, q.owner);
  }
  return t.filter((x): x is string => typeof x === "string" && x.length > 0);
}

const daysBetween = (a: string, b: Date) => Math.floor((b.getTime() - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Errors block a save: a reader would be misled or lost. Warnings are editing notes: each one
 * points at something that a reader would trip over, so fix most of them too.
 */
export function lintBrief(input: unknown, now = new Date()): Lint {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);
  const warn = (m: string) => warnings.push(m);
  if (!isObj(input)) return { errors: ["the spec must be a JSON object"], warnings, words: 0 };
  const b = input as unknown as Brief;
  if (b.schema !== BRIEF_SCHEMA) err(`schema must be "${BRIEF_SCHEMA}"`);
  for (const f of ["key", "title", "ask", "verified_on"] as const) if (!str(b[f])) err(`${f} is missing`);
  if (!["S", "M", "L"].includes(b.size)) err("size must be S, M or L");
  if (str(b.verified_on) && !/^\d{4}-\d{2}-\d{2}$/.test(b.verified_on)) err("verified_on must be YYYY-MM-DD");
  else if (str(b.verified_on) && daysBetween(b.verified_on, now) > 7) warn(`verified_on is ${daysBetween(b.verified_on, now)} days old: re-check PR states, dates and ticket status`);
  if (str(b.ask) && (b.ask.match(/[.!?](\s|$)/g) ?? []).length > 1) warn("ask: keep it to one sentence");
  if (str(b.title) && b.title.length > 90) warn("title: keep it under 90 characters");

  // Facts: every claim on the page can be checked.
  const facts = new Map<string, Fact>();
  if (!Array.isArray(b.facts) || b.facts.length === 0) err("facts: the ledger is empty, so no claim can be checked");
  for (const [i, f] of (Array.isArray(b.facts) ? b.facts : []).entries()) {
    if (!isObj(f) || !str(f.id) || !str(f.text) || !str(f.source)) {
      err(`facts[${i}] needs id, text and source`);
      continue;
    }
    if (!(f.how in BADGE)) err(`fact ${f.id}: how must be verified, read, said or inferred`);
    if (facts.has(f.id)) err(`fact ${f.id} is in the ledger twice`);
    facts.set(f.id, f);
    if (NARRATION.test(f.text)) warn(`fact ${f.id}: state the result, not the investigation ("Y happens", with how=verified)`);
  }
  const cite = (id: string | undefined, where: string) => {
    if (id === undefined) return;
    if (!facts.has(id)) err(`${where} cites fact "${id}", which is not in facts`);
  };

  for (const [i, l] of (b.links ?? []).entries()) if (!isObj(l) || !str(l.label) || !str(l.url) || !/^https?:\/\//.test(l.url)) err(`links[${i}] needs a label and an http(s) url`);

  // At a glance.
  const g = b.glance;
  if (!g) warn("glance is missing: a reader wants the From → To rows first");
  else {
    const n = g.shifts?.length ?? 0;
    if (n < 2 || n > CAPS.shifts) err(`glance.shifts: ${n} rows; give 2 to ${CAPS.shifts}`);
    for (const [i, s] of (g.shifts ?? []).entries()) if (!str(s.what) || !str(s.before) || !str(s.after)) err(`glance.shifts[${i}] needs what, before and after`);
    if ((g.numbers?.length ?? 0) > CAPS.numbers) err(`glance.numbers: at most ${CAPS.numbers}`);
    for (const [i, s] of (g.numbers ?? []).entries()) {
      if (!str(s.value) || !str(s.label)) err(`glance.numbers[${i}] needs value and label`);
      if (!s.fact) warn(`glance.numbers[${i}] "${s.value}" has no fact: a number needs a source`);
      cite(s.fact, `glance.numbers[${i}]`);
      if (s.value && s.value.length > 9) warn(`glance.numbers[${i}]: "${s.value}" is long for a big number; move words into the label`);
    }
    if ((g.headsups?.length ?? 0) > CAPS.headsups) err(`glance.headsups: ${g.headsups!.length}; keep the ${CAPS.headsups} that would cause the most rework`);
    for (const [i, h] of (g.headsups ?? []).entries()) {
      if (!str(h.title) || !str(h.body)) err(`glance.headsups[${i}] needs title and body`);
      if (!h.facts?.length) warn(`glance.headsups[${i}] "${h.title}" cites no fact`);
      for (const id of h.facts ?? []) cite(id, `glance.headsups[${i}]`);
      if (h.facts?.length && h.facts.every((id) => facts.get(id)?.how === "inferred") && !/unverified/i.test(h.body)) warn(`glance.headsups[${i}] rests on inferred facts only: say "unverified" in its body`);
    }
  }
  if (b.size !== "S" && !g?.headsups?.length) warn("no heads-ups: an M or L ticket almost always disagrees with reality somewhere (see the eight probes)");

  // The map.
  if (b.system) lintMap(b.system, err, warn, cite);
  if (b.flow) lintFlow(b.flow, err, warn);
  if (!b.system && !b.flow) warn("no system map and no flow: the page has no picture");

  // Done.
  if (!b.done?.items?.length) err("done: say what is true when the ticket is finished");
  else {
    if (b.done.items.length > CAPS.done) err(`done.items: ${b.done.items.length}; keep at most ${CAPS.done}`);
    for (const [i, d] of b.done.items.entries()) {
      if (!str(d.text)) err(`done.items[${i}] needs text`);
      if (!str(d.verify)) err(`done.items[${i}] "${d.text ?? ""}" has no verify: how does the engineer prove it?`);
      cite(d.fact, `done.items[${i}]`);
    }
    for (const [i, a] of (b.done.ac_review ?? []).entries()) {
      if (!str(a.ac) || !["ok", "change", "drop", "add"].includes(a.verdict)) err(`done.ac_review[${i}] needs ac and a verdict: ok, change, drop or add`);
      if (a.verdict !== "ok" && !str(a.note)) err(`done.ac_review[${i}]: a ${a.verdict} needs a note that says what to write instead`);
    }
  }

  // Path.
  if (b.path) {
    if ((b.path.steps?.length ?? 0) > CAPS.path) err(`path.steps: at most ${CAPS.path}`);
    for (const [i, s] of (b.path.steps ?? []).entries()) if (!str(s.title) || !str(s.who)) err(`path.steps[${i}] needs title and who`);
    if ((b.path.steps ?? []).length > 1 && !(b.path.steps ?? []).some((s) => s.gate || s.undo)) warn("path: no step has a gate or an undo; say how each risky step is checked and reversed");
  }

  // Decisions.
  if (b.decisions) {
    const major = b.decisions.major ?? [];
    if (major.length > CAPS.major) err(`decisions.major: ${major.length}; at most ${CAPS.major}. Move the rest to minor`);
    for (const [i, d] of major.entries()) {
      const at = `decisions.major[${i}]`;
      if (!str(d.question) || !str(d.why)) err(`${at} needs question and why`);
      if (!str(d.decider) || /^(tbd|team|someone|\?|n\/a)$/i.test(d.decider.trim())) err(`${at}: the decider must be a name`);
      const crit = d.criteria ?? [];
      if (crit.length < 2 || crit.length > 5) err(`${at}: give 2 to 5 criteria that separate the options`);
      if (crit.some((c) => /^(cost|effort|complexity|risk|time)$/i.test(c.trim()))) warn(`${at}: a one-word criterion such as "cost" separates nothing; say what differs ("Old CLIs keep their auth")`);
      const opts = d.options ?? [];
      if (opts.length < 2 || opts.length > 4) err(`${at}: give 2 to 4 options`);
      const rec = opts.filter((o) => o.recommended).length;
      if (rec !== 1) err(`${at}: exactly one option must be recommended (now ${rec})`);
      for (const o of opts) {
        if ((o.cells ?? []).length !== crit.length) err(`${at} option "${o.name}": ${o.cells?.length ?? 0} cells for ${crit.length} criteria`);
        for (const c of o.cells ?? []) if (!/^[+~-] \S/.test(c)) err(`${at} option "${o.name}": cell "${c}" must start with "+ ", "~ " or "- "`);
      }
      // A criterion where every option scores the same separates nothing.
      for (const [j, c] of crit.entries()) {
        const marks = new Set(opts.map((o) => o.cells?.[j]?.[0]));
        if (opts.length > 1 && marks.size === 1) warn(`${at}: criterion "${c}" scores the same for every option, so it does not help to decide`);
      }
      for (const id of d.facts ?? []) cite(id, at);
    }
    for (const [i, m] of (b.decisions.minor ?? []).entries()) if (!str(m.question) || !str(m.call)) err(`decisions.minor[${i}] needs question and call`);
  }

  // People.
  if (b.people) {
    if ((b.people.rows?.length ?? 0) > CAPS.people) err(`people.rows: at most ${CAPS.people}`);
    for (const [i, p] of (b.people.rows ?? []).entries()) {
      if (!str(p.who) || !str(p.before) || !str(p.after)) err(`people.rows[${i}] needs who, before and after`);
      if (/\bI want\b|^as an? /i.test(`${p.who} ${p.before} ${p.after}`)) warn(`people.rows[${i}]: a user story is a task; put it in done. A row here is a person whose experience changes`);
    }
  }

  // Work.
  if (!b.work) warn("work is missing: say where the engineer starts");
  else {
    if (!str(b.work.first_move)) err("work.first_move: say what the engineer does first");
    if ((b.work.repos?.length ?? 0) > CAPS.repos) err(`work.repos: at most ${CAPS.repos}`);
    for (const [i, r] of (b.work.repos ?? []).entries()) {
      if (!str(r.repo) || !str(r.why)) err(`work.repos[${i}] needs repo and why`);
      if (!["agent", "human", "either"].includes(r.who)) err(`work.repos[${i}]: who must be agent, human or either`);
      if (!r.paths?.length) warn(`work.repos[${i}] "${r.repo}" lists no paths`);
      if (r.url && !/^https?:\/\//.test(r.url)) err(`work.repos[${i}]: url must be http(s)`);
      if (r.pr && (!/^https?:\/\//.test(r.pr.url ?? "") || !["draft", "open", "merged", "closed"].includes(r.pr.state))) err(`work.repos[${i}].pr needs an http(s) url and a state: draft, open, merged or closed`);
    }
    if (b.size !== "S" && !(b.work.repos ?? []).some((r) => r.who !== "agent" || r.human_only)) warn("work: no repo says what only a human can do (prod writes, console, merges)");
  }

  // Risks.
  for (const [i, r] of (b.risks?.items ?? []).entries()) {
    if (!str(r.text)) err(`risks.items[${i}] needs text`);
    cite(r.fact, `risks.items[${i}]`);
  }
  for (const [i, q] of (b.risks?.questions ?? []).entries()) if (!str(q.q) || !str(q.owner)) err(`risks.questions[${i}] needs q and owner`);

  // Size: a one-line bug fix with every section is a failure.
  if (b.size === "S") {
    for (const s of ["path", "decisions", "people"] as const) if (b[s]) warn(`size S: drop ${s} unless the ticket truly needs it`);
  }
  if (b.size === "M" && b.people && !b.people.rows?.length) warn("people: empty; omit the section");

  // Headings are claims.
  const headings: [string, string | undefined][] = [
    ["system.heading", b.system?.heading],
    ["flow.heading", b.flow?.heading],
    ["done.heading", b.done?.heading],
    ["path.heading", b.path?.heading],
    ["decisions.heading", b.decisions?.heading],
    ["people.heading", b.people?.heading],
    ["work.heading", b.work?.heading],
    ["risks.heading", b.risks?.heading],
  ];
  for (const [at, h] of headings) if (h && GENERIC_HEADINGS.test(h.trim())) warn(`${at}: "${h}" names a topic; write a claim ("Released CLIs call a URL we cannot move")`);

  // Words and hygiene.
  let text: string[] = [];
  try {
    text = visibleText(b);
  } catch {
    err("the spec has the wrong shape somewhere: see docs/ticket-brief/SPEC.md");
  }
  const count = text.reduce((n, s) => n + words(s), 0);
  if (str(b.size) && b.size in WORD_BUDGET && count > WORD_BUDGET[b.size]) warn(`${count} visible words; the budget for size ${b.size} is ${WORD_BUDGET[b.size]}. Cut, or move detail to the ledger`);
  const all = JSON.stringify(input);
  for (const [re, what] of SECRETS) if (re.test(all)) err(`the spec holds what looks like ${what}: remove it`);
  for (const s of text) if (NARRATION.test(s)) {
    warn(`"${s.slice(0, 60)}…": state the result with its badge, not the investigation`);
    break;
  }
  return { errors, warnings, words: count };
}

function lintMap(m: SystemMap, err: (s: string) => void, warn: (s: string) => void, cite: (id: string | undefined, where: string) => void): void {
  if (!str(m.heading)) err("system.heading: write a claim");
  const nodes = new Map<string, MapNode>();
  for (const [i, n] of (m.nodes ?? []).entries()) {
    if (!str(n.id) || !str(n.label) || !Number.isInteger(n.col) || !Number.isInteger(n.row) || n.col < 0 || n.row < 0) {
      err(`system.nodes[${i}] needs id, label, and whole-number col and row from 0`);
      continue;
    }
    if (nodes.has(n.id)) err(`system node ${n.id} is there twice`);
    nodes.set(n.id, n);
    if (n.col > 4) err(`system node ${n.id}: col ${n.col}; use at most 5 columns (0 to 4), or the map does not fit the page`);
    if (n.row > 4) err(`system node ${n.id}: row ${n.row}; use at most 5 rows (0 to 4)`);
    if (n.label.length > 22) warn(`system node ${n.id}: label "${n.label}" is over 22 characters and will be cut; put detail in sub`);
    if (n.sub && n.sub.length > 46) warn(`system node ${n.id}: sub is over 46 characters (two lines of about 23)`);
    if (n.kind && !["actor", "service", "store", "external"].includes(n.kind)) err(`system node ${n.id}: kind must be actor, service, store or external`);
  }
  const views = m.views ?? [];
  if (views.length < 1 || views.length > CAPS.views) err(`system.views: ${views.length}; give 1 to ${CAPS.views} (Today, During, Done)`);
  if (views.length === 1) warn("system.views: one view shows no change; add the Done view on the same canvas");
  const states = viewStates({ ...m, nodes: [...nodes.values()] });
  for (const [vi, v] of views.entries()) {
    const at = `system view ${v.id ?? vi}`;
    if (!str(v.id) || !str(v.label)) err(`system.views[${vi}] needs id and label`);
    for (const id of [...(v.hide ?? []), ...(v.changed ?? []), ...Object.keys(v.notes ?? {})]) if (!nodes.has(id)) err(`${at} names node "${id}", which is not in system.nodes`);
    const st = states[vi];
    const visible = [...nodes.values()].filter((n) => st?.has(n.id) && st.get(n.id) !== "gone");
    if (visible.length > CAPS.nodesPerView) err(`${at}: ${visible.length} nodes; at most ${CAPS.nodesPerView}. Merge boxes or drop ones the ticket does not touch`);
    const drawn = [...nodes.values()].filter((n) => st?.has(n.id));
    const cells = new Map<string, string>();
    for (const n of drawn) {
      const c = `${n.col},${n.row}`;
      if (cells.has(c)) err(`${at}: nodes ${cells.get(c)} and ${n.id} sit in the same cell (${c})`);
      cells.set(c, n.id);
    }
    const seen = new Set<string>();
    const a0 = (id: string) => (st?.has(id) && st.get(id) !== "gone" ? nodes.get(id) : undefined);
    for (const [ei, e] of (v.edges ?? []).entries()) {
      for (const end of [e.from, e.to]) {
        if (!nodes.has(end)) err(`${at} edge ${ei} names node "${end}", which is not in system.nodes`);
        else if (!st?.has(end) || st.get(end) === "gone") err(`${at} edge ${e.from}→${e.to}: node ${end} is hidden in this view`);
      }
      if (e.label && e.label.length > 26) warn(`${at} edge ${e.from}→${e.to}: label "${e.label}" is over 26 characters; long labels float away from their line`);
      if (e.label && a0(e.from) && a0(e.to) && e.from !== e.to) {
        const pair = (v.edges ?? []).some((x) => x.from === e.to && x.to === e.from);
        const r = routeEdge(nodeBox(a0(e.from)!), nodeBox(a0(e.to)!), drawn.filter((n) => n.id !== e.from && n.id !== e.to).map(nodeBox), pair ? 0.18 : 0);
        if (!placeLabel(e.label, r.label, drawn.map(nodeBox)).clear) warn(`${at} edge ${e.from}→${e.to}: label "${e.label}" covers a box; shorten it, drop it, or leave a free column between the two nodes`);
      }
      if (seen.has(`${e.from}>${e.to}`)) warn(`${at}: two edges ${e.from}→${e.to}; merge their labels`);
      seen.add(`${e.from}>${e.to}`);
      const a = nodes.get(e.from);
      const z = nodes.get(e.to);
      if (a && z && a !== z) {
        const others = drawn.filter((n) => n !== a && n !== z).map(nodeBox);
        const pair = (v.edges ?? []).some((x) => x.from === e.to && x.to === e.from);
        if (!routeEdge(nodeBox(a), nodeBox(z), others, pair ? 0.18 : 0).clear) warn(`${at} edge ${e.from}→${e.to} crosses another box; move a node so the line is clear`);
      }
    }
    const pins = v.pins ?? [];
    if (pins.length > CAPS.pinsPerView) err(`${at}: ${pins.length} pins; at most ${CAPS.pinsPerView}`);
    for (const p of pins) {
      if (!nodes.has(p.node)) err(`${at} pin names node "${p.node}", which is not in system.nodes`);
      if (!str(p.text)) err(`${at}: a pin needs text`);
      cite(p.fact, `${at} pin`);
    }
    if (vi === 0 && !pins.length) warn(`${at}: the first view has no problem pins; pin the 1 to 3 things wrong today`);
    const isolated = visible.filter((n) => !(v.edges ?? []).some((e) => e.from === n.id || e.to === n.id));
    if (isolated.length) warn(`${at}: ${isolated.map((n) => n.id).join(", ")} has no edge; connect it, or hide it in this view`);
  }
  if (views.length > 1 && views.every((v, i) => i === 0 || (!(v.hide ?? []).length && !(v.changed ?? []).length && JSON.stringify(v.edges) === JSON.stringify(views[0].edges)))) warn("system.views: the views look the same; show what moves");
}

function lintFlow(f: Flow, err: (s: string) => void, warn: (s: string) => void): void {
  if (!str(f.heading)) err("flow.heading: write a claim");
  const lanes = new Set((f.lanes ?? []).map((l) => l.id));
  if (lanes.size < 2 || lanes.size > CAPS.flowLanes) err(`flow.lanes: give 2 to ${CAPS.flowLanes}`);
  for (const l of f.lanes ?? []) if (l.label && l.label.length > 20) warn(`flow lane ${l.id}: label over 20 characters`);
  if (!f.steps?.length || f.steps.length > CAPS.flowSteps) err(`flow.steps: give 1 to ${CAPS.flowSteps}`);
  for (const [i, s] of (f.steps ?? []).entries()) {
    if (!lanes.has(s.from) || !lanes.has(s.to)) err(`flow.steps[${i}] names a lane that is not in flow.lanes`);
    if (!str(s.label)) err(`flow.steps[${i}] needs a label`);
    if (s.label && s.label.length > 40) warn(`flow.steps[${i}]: label over 40 characters`);
  }
  if (!(f.steps ?? []).some((s) => s.tone === "bad" || s.note)) warn("flow: no step is marked bad or has a note; mark the failing or suspect step");
}

// ---- text, TL;DR, diff ---------------------------------------------------------------------

const factTag = (b: Brief, id?: string) => {
  const f = id ? b.facts.find((x) => x.id === id) : undefined;
  return f ? ` (${BADGE[f.how]} ${f.id})` : "";
};

/** The brief in reading order, as plain text: for the cold-reader test, and for an agent with no browser. */
export function briefText(b: Brief): string {
  const out: string[] = [];
  const h = (s: string) => out.push("", s.toUpperCase(), "-".repeat(Math.min(s.length, 72)));
  out.push(
    `${b.key}: ${b.title}`,
    `Size ${b.size}. Facts checked on ${b.verified_on}.`,
    "Evidence tags: V verified (ran it), R read (code, config, docs), S said (a person said it), I inferred. Decision marks: + good, ~ mixed, - bad.",
    "",
    `ASK: ${b.ask}`,
  );
  for (const l of b.links ?? []) out.push(`  ${l.label}: ${l.url}`);
  if (b.glance) {
    h("At a glance");
    for (const s of b.glance.shifts) out.push(`- ${s.what}. Today: ${s.before}. When done: ${s.after}.`);
    for (const s of b.glance.numbers ?? []) out.push(`* ${s.value}: ${s.label}${factTag(b, s.fact)}`);
    for (const x of b.glance.headsups ?? []) {
      out.push("", `HEADS-UP: ${x.title}`);
      if (x.ticket_says) out.push(`  The ticket says: ${x.ticket_says}`);
      out.push(`  Reality: ${x.body}${x.facts?.length ? ` (${x.facts.map((id) => factTag(b, id).trim().replace(/[()]/g, "")).join(", ")})` : ""}`);
    }
  }
  if (b.system) {
    h(b.system.heading);
    const byId = new Map(b.system.nodes.map((n) => [n.id, n]));
    const states = viewStates(b.system);
    for (const [i, v] of b.system.views.entries()) {
      out.push("", `[Map view ${i + 1}: ${v.label}]${v.caption ? ` ${v.caption}` : ""}`);
      const st = states[i];
      for (const n of b.system.nodes) {
        const s = st.get(n.id);
        if (!s) continue;
        const note = v.notes?.[n.id] ?? n.sub;
        out.push(`  box ${n.label}${note ? ` (${note})` : ""}${s === "same" ? "" : ` [${s === "gone" ? "REMOVED" : s.toUpperCase()}]`}`);
      }
      for (const e of v.edges) out.push(`  ${byId.get(e.from)?.label ?? e.from} --${e.label ? ` ${e.label} ` : ""}${e.tone === "bad" ? "(broken)" : ""}--> ${byId.get(e.to)?.label ?? e.to}`);
      for (const [j, p] of (v.pins ?? []).entries()) out.push(`  (${j + 1}) at ${byId.get(p.node)?.label ?? p.node}: ${p.text}${factTag(b, p.fact)}`);
    }
  }
  if (b.flow) {
    h(b.flow.heading);
    const lane = new Map(b.flow.lanes.map((l) => [l.id, l.label]));
    for (const [i, s] of b.flow.steps.entries()) out.push(`${i + 1}. ${lane.get(s.from)} -> ${lane.get(s.to)}: ${s.label}${s.tone === "bad" ? "  <-- FAILS HERE" : ""}${s.note ? ` (${s.note})` : ""}`);
  }
  if (b.done) {
    h(b.done.heading ?? DEFAULT_HEADING.done);
    for (const d of b.done.items) out.push(`[ ] ${d.text}${factTag(b, d.fact)}`, `    Prove it: ${d.verify}`);
    if (b.done.ac_review?.length) {
      out.push("", "Acceptance criteria check:");
      for (const a of b.done.ac_review) out.push(`  ${a.verdict.toUpperCase()}: ${a.ac}${a.note ? ` -> ${a.note}` : ""}`);
    }
  }
  if (b.path) {
    h(b.path.heading ?? DEFAULT_HEADING.path);
    for (const [i, s] of b.path.steps.entries()) {
      out.push(`${i + 1}. ${s.title}${s.date ? ` (${s.date})` : ""}${s.state ? ` [${s.state}]` : ""}. Who: ${s.who}${s.human ? " (only a human)" : ""}.`);
      if (s.detail) out.push(`   ${s.detail}`);
      if (s.gate) out.push(`   Gate: ${s.gate}`);
      if (s.undo) out.push(`   Undo: ${s.undo}`);
    }
  }
  if (b.decisions) {
    h(b.decisions.heading ?? DEFAULT_HEADING.decisions);
    for (const d of b.decisions.major) {
      out.push("", `DECISION: ${d.question} Decider: ${d.decider}.`);
      for (const o of d.options) out.push(`  ${o.recommended ? "* RECOMMENDED " : "  "}${o.name}: ${o.cells.map((c, j) => `${d.criteria[j]} ${c}`).join("; ")}`);
      out.push(`  Why: ${d.why}`);
    }
    if (b.decisions.minor?.length) {
      out.push("", "Smaller calls:");
      for (const m of b.decisions.minor) out.push(`  - ${m.question} ${m.call}${m.decider ? ` (${m.decider})` : ""}`);
    }
  }
  if (b.people) {
    h(b.people.heading ?? DEFAULT_HEADING.people);
    for (const p of b.people.rows) out.push(`- ${p.who}. Today: ${p.before}. When done: ${p.after}.`);
  }
  if (b.work) {
    h(b.work.heading ?? DEFAULT_HEADING.work);
    out.push(`FIRST MOVE: ${b.work.first_move}`);
    for (const r of b.work.repos) {
      out.push("", `${r.repo}${r.url ? ` (${r.url})` : ""}. Who: ${r.who}. ${r.why}`);
      for (const p of r.paths) out.push(`  ${p}`);
      if (r.pr) out.push(`  PR: ${r.pr.label} [${r.pr.state}] ${r.pr.url}`);
      if (r.human_only) out.push(`  Only a human: ${r.human_only}`);
    }
  }
  if (b.risks) {
    h(b.risks.heading ?? DEFAULT_HEADING.risks);
    for (const r of b.risks.items) out.push(`- ${r.text}${r.mitigation ? ` Mitigation: ${r.mitigation}` : ""}${factTag(b, r.fact)}`);
    for (const q of b.risks.questions ?? []) out.push(`? ${q.q} (owner: ${q.owner})`);
  }
  h("Evidence");
  for (const f of b.facts) out.push(`${f.id} [${BADGE[f.how]}] ${f.text} (source: ${f.source}${f.as_of ? `, ${f.as_of}` : ""})`);
  for (const g of b.glossary ?? []) out.push(`${g.term}: ${g.means}`);
  return `${out.join("\n").trim()}\n`;
}

/** The 30-second version, for a Jira comment or a Slack post. `link` is where the full page is. */
export function briefTldr(b: Brief, link?: string): string {
  const out = [`**${b.key}: ${b.title}** (brief, facts checked ${b.verified_on})`, "", b.ask];
  if (b.glance?.shifts.length) out.push("", "**What changes**", ...b.glance.shifts.map((s) => `- ${s.what}: ${s.before} → ${s.after}`));
  if (b.glance?.headsups?.length) out.push("", "**Heads-up: the ticket and reality differ**", ...b.glance.headsups.map((h) => `- **${h.title}.** ${h.body}`));
  const major = b.decisions?.major ?? [];
  if (major.length) out.push("", "**Decisions**", ...major.map((d) => `- ${d.question} Recommended: ${d.options.find((o) => o.recommended)?.name ?? "?"}. Decider: ${d.decider}.`));
  if (b.done?.items.length) out.push("", "**Done when**", ...b.done.items.map((d) => `- ${d.text}`));
  if (b.work?.first_move) out.push("", `**Start here:** ${b.work.first_move}`);
  if (link) out.push("", `Full brief: ${link}`);
  return `${out.join("\n")}\n`;
}

/** Each path in the spec with its value, keyed by id where a list has ids, so a reorder is no change. */
function flatten(v: unknown, path: string, out: Map<string, string>): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      const key = isObj(x) ? (x.id ?? x.repo ?? x.question ?? x.title ?? x.what ?? x.who ?? x.term ?? x.name ?? i) : i;
      flatten(x, `${path}[${String(key)}]`, out);
    });
  } else if (isObj(v)) for (const [k, x] of Object.entries(v)) flatten(x, path ? `${path}.${k}` : k, out);
  else out.set(path, String(v));
}

/** What changed between two versions of a brief: the first lines of an update's reply. */
export function diffBriefs(before: Brief, after: Brief): string[] {
  const a = new Map<string, string>();
  const z = new Map<string, string>();
  flatten(before, "", a);
  flatten(after, "", z);
  const lines: string[] = [];
  const short = (s: string) => (s.length > 90 ? `${s.slice(0, 89)}…` : s);
  for (const [k, v] of z) {
    if (!a.has(k)) lines.push(`+ ${k}: ${short(v)}`);
    else if (a.get(k) !== v) lines.push(`~ ${k}: ${short(a.get(k)!)} → ${short(v)}`);
  }
  for (const [k, v] of a) if (!z.has(k)) lines.push(`- ${k}: ${short(v)}`);
  return lines.length ? lines : ["No change."];
}
