/**
 * Renders a ticket brief as HTML and SVG strings. One renderer for three places: the brief on the
 * dashboard, the self-contained HTML file that goes on the Jira ticket, and the SVG attachments.
 * The page needs no script: the map views are CSS radio tabs, the ledger is a <details>.
 * Every text goes through `esc`, and only an http(s) URL becomes a link, because an agent wrote the spec.
 */
import {
  BADGE,
  type Brief,
  canvasSize,
  CAPS,
  DEFAULT_HEADING,
  type Fact,
  type Flow,
  GRID,
  HOW_MEANS,
  type MapView,
  nodeBox,
  type NodeState,
  placeLabel,
  routeEdge,
  type SystemMap,
  viewStates,
  visibleText,
} from "./brief.ts";

export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Escaped text with `code` and **bold**, the only markup a spec field may use. */
export function fmt(s: string | undefined): string {
  return esc(s ?? "")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

const safeUrl = (u: string | undefined) => (u && /^https?:\/\//.test(u) ? esc(u) : null);
const link = (label: string, url: string | undefined, cls = "") => {
  const u = safeUrl(url);
  return u ? `<a${cls ? ` class="${cls}"` : ""} href="${u}" target="_blank" rel="noreferrer">${fmt(label)}</a>` : fmt(label);
};

let seq = 0;
/** Ids inside one rendered brief: two briefs on one page must not share a radio group or a marker. */
const uidFor = (b: Brief) => `${b.key.replace(/[^A-Za-z0-9]/g, "")}${++seq}`;

// ---- SVG -----------------------------------------------------------------------------------

/** The colors that a standalone SVG uses; on the page the same classes take the theme's colors. */
const SVG_STYLE = `
.tb-svg-bg{fill:#fff}
.tb-n rect,.tb-n path.tb-shape{fill:#fff;stroke:#3c3c43;stroke-width:1.3}
.tb-k-external rect{stroke-dasharray:5 4}
.tb-k-actor rect{fill:#f4f3ef}
.tb-s-new rect,.tb-s-new path.tb-shape{stroke:#12925b;stroke-width:2.2;fill:#e6f5ee}
.tb-s-changed rect,.tb-s-changed path.tb-shape{stroke:#b7791f;stroke-width:2.2;fill:#fbf3e2}
.tb-s-gone{opacity:.42}
.tb-s-gone rect,.tb-s-gone path.tb-shape{stroke-dasharray:4 4}
.tb-nl{font:600 14.5px -apple-system,BlinkMacSystemFont,"Inter",sans-serif;fill:#16161a}
.tb-ns{font:12px -apple-system,BlinkMacSystemFont,"Inter",sans-serif;fill:#86868b}
.tb-tag rect{stroke:none}
.tb-tag text{font:700 9px -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.06em;fill:#fff}
.tb-tag-new rect{fill:#12925b}.tb-tag-changed rect{fill:#b7791f}.tb-tag-gone rect{fill:#86868b}
.tb-e{fill:none;stroke:#86868b;stroke-width:1.5}
.tb-e-bad{stroke:#d92d20;stroke-width:2}
.tb-e-new{stroke:#12925b;stroke-width:2}
.tb-e-dashed{stroke-dasharray:5 4}
.tb-ah{fill:#86868b}.tb-ah-bad{fill:#d92d20}.tb-ah-new{fill:#12925b}
.tb-el rect{fill:#fff;stroke:none;opacity:.94}
.tb-el text{font:12px -apple-system,BlinkMacSystemFont,"Inter",sans-serif;fill:#3c3c43}
.tb-el-bad text{fill:#d92d20;font-weight:600}
.tb-pin circle{fill:#d92d20;stroke:#fff;stroke-width:2}
.tb-pin text{font:700 11px -apple-system,BlinkMacSystemFont,sans-serif;fill:#fff}
.tb-lg{font:12px -apple-system,BlinkMacSystemFont,"Inter",sans-serif;fill:#3c3c43}
.tb-lane rect{fill:#f4f3ef;stroke:#3c3c43;stroke-width:1.2}
.tb-lane text{font:600 12px -apple-system,BlinkMacSystemFont,"Inter",sans-serif;fill:#16161a}
.tb-life{stroke:#d4d2cb;stroke-width:1.2;stroke-dasharray:4 4}
.tb-step-n{font:600 11px ui-monospace,Menlo,monospace;fill:#86868b}
.tb-step-l{font:12px -apple-system,BlinkMacSystemFont,"Inter",sans-serif;fill:#16161a}
.tb-step-note{font:11px -apple-system,BlinkMacSystemFont,"Inter",sans-serif;fill:#86868b}
.tb-step-bad .tb-step-l,.tb-step-bad .tb-step-note{fill:#d92d20}
.tb-x circle{fill:#d92d20}.tb-x path{stroke:#fff;stroke-width:2}
`;

/** One line, or two of about equal length split at the space nearest the middle, so no line holds one orphan word. */
function wrap(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  // A space is the best place to cut; a host or a path has none, so after a dot, slash or dash.
  const at = (re: RegExp) => [...s.matchAll(re)].map((m) => m.index);
  const near = (xs: number[]) => xs.reduce((best, i) => (Math.abs(i - s.length / 2) < Math.abs(best - s.length / 2) ? i : best));
  const spaces = at(/ /g);
  if (spaces.length) {
    const cut = near(spaces);
    if (cut <= max && s.length - cut - 1 <= max) return [s.slice(0, cut), s.slice(cut + 1)];
  }
  const marks = at(/[./-]/g);
  if (marks.length) {
    const cut = near(marks) + 1;
    return [clip(s.slice(0, cut), max), clip(s.slice(cut), max)];
  }
  const cut = spaces.length ? near(spaces) : max;
  return [clip(s.slice(0, cut), max), clip(s.slice(cut).trim(), max)];
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const markers = (uid: string) =>
  `<defs>${["", "-bad", "-new"].map((t) => `<marker id="tb-ah${t}-${uid}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="tb-ah${t}" d="M0,0 L10,5 L0,10 z"/></marker>`).join("")}</defs>`;

const STATE_TAG: Partial<Record<NodeState, string>> = { new: "NEW", changed: "CHANGED", gone: "REMOVED" };

function nodeSvg(n: SystemMap["nodes"][number], state: NodeState, note: string | undefined): string {
  const b = nodeBox(n);
  const kind = n.kind ?? "service";
  let shape: string;
  if (kind === "store") {
    const e = 7;
    shape = `<path class="tb-shape" d="M${b.x},${b.y + e} a${b.w / 2},${e} 0 0,1 ${b.w},0 v${b.h - 2 * e} a${b.w / 2},${e} 0 0,1 ${-b.w},0 z M${b.x},${b.y + e} a${b.w / 2},${e} 0 0,0 ${b.w},0"/>`;
  } else shape = `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${kind === "actor" ? b.h / 2 : 10}"/>`;
  const sub = note ?? n.sub;
  const subLines = sub ? wrap(sub, 24) : [];
  const cx = b.x + b.w / 2;
  const top = b.y + b.h / 2 - (subLines.length * 13) / 2 + (kind === "store" ? 4 : 0) + (subLines.length ? 1 : 0);
  const label = `<text class="tb-nl" x="${cx}" y="${top + (subLines.length ? 0 : 5)}" text-anchor="middle">${esc(clip(n.label, 22))}</text>`;
  const subs = subLines.map((l, i) => `<text class="tb-ns" x="${cx}" y="${top + 15 + i * 13.5}" text-anchor="middle">${esc(l)}</text>`).join("");
  const tag = STATE_TAG[state];
  const tagSvg = tag ? `<g class="tb-tag tb-tag-${state}"><rect x="${b.x + 8}" y="${b.y - 11}" width="${tag.length * 6.4 + 10}" height="14" rx="7"/><text x="${b.x + 13}" y="${b.y - 1}">${tag}</text></g>` : "";
  return `<g class="tb-n tb-k-${kind} tb-s-${state}"><title>${esc(n.label)}${sub ? `: ${esc(sub)}` : ""}</title>${shape}${label}${subs}${tagSvg}</g>`;
}

/** One view of the system map. `standalone` makes a file of its own: XML namespace, colors, and the pins written under the map. */
export function mapSvg(map: SystemMap, viewIndex: number, opts: { standalone?: boolean; uid?: string; title?: string } = {}): string {
  const v = map.views[viewIndex];
  const states = viewStates(map)[viewIndex];
  const uid = opts.uid ?? `m${++seq}`;
  const { w, h: mapH } = canvasSize(map.nodes);
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const drawn = map.nodes.filter((n) => states.has(n.id));
  const pins = v.pins ?? [];
  const legendH = opts.standalone ? 30 + pins.length * 18 + (opts.title ? 0 : 0) : 0;
  const titleH = opts.standalone && opts.title ? 30 : 0;
  const H = mapH + legendH + titleH;
  const parts: string[] = [];
  if (opts.standalone) parts.push(`<style>${SVG_STYLE}</style><rect class="tb-svg-bg" width="${w}" height="${H}"/>`);
  parts.push(markers(uid));
  if (titleH) parts.push(`<text class="tb-nl" x="${GRID.pad}" y="22">${esc(opts.title)}</text>`);
  parts.push(`<g transform="translate(0,${titleH})">`);
  const labels: string[] = [];
  for (const e of v.edges) {
    const a = byId.get(e.from);
    const z = byId.get(e.to);
    if (!a || !z || a === z) continue;
    const others = drawn.filter((n) => n !== a && n !== z).map(nodeBox);
    const pair = v.edges.some((x) => x.from === e.to && x.to === e.from);
    const r = routeEdge(nodeBox(a), nodeBox(z), others, pair ? 0.18 : 0);
    const tone = e.tone ?? "normal";
    const mk = tone === "bad" ? "-bad" : tone === "new" ? "-new" : "";
    const d = r.control ? `M${r.start.x.toFixed(1)},${r.start.y.toFixed(1)} Q${r.control.x.toFixed(1)},${r.control.y.toFixed(1)} ${r.end.x.toFixed(1)},${r.end.y.toFixed(1)}` : `M${r.start.x.toFixed(1)},${r.start.y.toFixed(1)} L${r.end.x.toFixed(1)},${r.end.y.toFixed(1)}`;
    parts.push(`<path class="tb-e tb-e-${tone}" d="${d}" marker-end="url(#tb-ah${mk}-${uid})"/>`);
    if (e.label) {
      const p = placeLabel(clip(e.label, 30), r.label, drawn.map(nodeBox));
      const cx = p.box.x + p.box.w / 2;
      const text = p.lines.map((l, i) => `<text x="${cx.toFixed(1)}" y="${(p.box.y + 13 + i * 14.5).toFixed(1)}" text-anchor="middle">${esc(l)}</text>`).join("");
      labels.push(`<g class="tb-el tb-el-${tone}"><rect x="${p.box.x.toFixed(1)}" y="${p.box.y.toFixed(1)}" width="${p.box.w.toFixed(1)}" height="${p.box.h.toFixed(1)}" rx="4"/>${text}</g>`);
    }
  }
  for (const n of drawn) parts.push(nodeSvg(n, states.get(n.id)!, v.notes?.[n.id]));
  parts.push(...labels);
  pins.forEach((p, i) => {
    const n = byId.get(p.node);
    if (!n) return;
    const b = nodeBox(n);
    // Two pins on one box sit side by side.
    const k = pins.slice(0, i).filter((q) => q.node === p.node).length;
    const x = b.x + b.w - 6 - k * 22;
    parts.push(`<g class="tb-pin"><title>${esc(p.text)}</title><circle cx="${x}" cy="${b.y + 1}" r="10"/><text x="${x}" y="${b.y + 5}" text-anchor="middle">${i + 1}</text></g>`);
  });
  parts.push("</g>");
  if (legendH) {
    const y0 = titleH + mapH + 6;
    pins.forEach((p, i) => {
      parts.push(`<g class="tb-pin"><circle cx="${GRID.pad + 9}" cy="${y0 + 8 + i * 18}" r="8"/><text x="${GRID.pad + 9}" y="${y0 + 12 + i * 18}" text-anchor="middle">${i + 1}</text></g><text class="tb-lg" x="${GRID.pad + 24}" y="${y0 + 12 + i * 18}">${esc(clip(p.text, Math.floor((w - 70) / 6.6)))}</text>`);
    });
    if (v.caption) parts.push(`<text class="tb-lg" x="${GRID.pad}" y="${y0 + 14 + pins.length * 18}">${esc(clip(v.caption, Math.floor((w - 40) / 6.6)))}</text>`);
  }
  const label = `${v.label}: ${map.nodes.filter((n) => states.get(n.id) && states.get(n.id) !== "gone").map((n) => n.label).join(", ")}`;
  const ns = opts.standalone ? ` xmlns="http://www.w3.org/2000/svg"` : "";
  return `<svg${ns} class="tb-map" viewBox="0 0 ${w} ${H}" width="${w}" height="${H}" role="img" aria-label="${esc(label)}">${parts.join("")}</svg>`;
}

const FLOW = { laneW: 156, gutter: 30, head: 34, rowH: 46, pad: 14 };

/** A sequence: who calls whom, in order, with the failing step marked. */
export function flowSvg(f: Flow, opts: { standalone?: boolean; uid?: string } = {}): string {
  const uid = opts.uid ?? `f${++seq}`;
  const x = new Map(f.lanes.map((l, i) => [l.id, FLOW.gutter + i * FLOW.laneW + FLOW.laneW / 2]));
  const w = FLOW.gutter + f.lanes.length * FLOW.laneW + FLOW.pad;
  const h = FLOW.pad + FLOW.head + f.steps.length * FLOW.rowH + FLOW.pad;
  const parts: string[] = [];
  if (opts.standalone) parts.push(`<style>${SVG_STYLE}</style><rect class="tb-svg-bg" width="${w}" height="${h}"/>`);
  parts.push(markers(uid));
  for (const l of f.lanes) {
    const cx = x.get(l.id)!;
    parts.push(`<line class="tb-life" x1="${cx}" y1="${FLOW.pad + FLOW.head}" x2="${cx}" y2="${h - FLOW.pad}"/>`);
    parts.push(`<g class="tb-lane"><rect x="${cx - FLOW.laneW / 2 + 8}" y="${FLOW.pad}" width="${FLOW.laneW - 16}" height="${FLOW.head - 4}" rx="8"/><text x="${cx}" y="${FLOW.pad + 19}" text-anchor="middle">${esc(clip(l.label, 22))}</text></g>`);
  }
  f.steps.forEach((s, i) => {
    const y = FLOW.pad + FLOW.head + i * FLOW.rowH + 28;
    const a = x.get(s.from) ?? 0;
    const z = x.get(s.to) ?? 0;
    const tone = s.tone ?? "normal";
    const mk = tone === "bad" ? "-bad" : tone === "new" ? "-new" : "";
    const bad = tone === "bad";
    parts.push(`<g class="tb-step${bad ? " tb-step-bad" : ""}">`);
    parts.push(`<text class="tb-step-n" x="6" y="${y + 4}">${i + 1}</text>`);
    let lx: number;
    if (a === z) {
      parts.push(`<path class="tb-e tb-e-${tone}" d="M${a + 4},${y - 8} h28 v16 h-24" marker-end="url(#tb-ah${mk}-${uid})"/>`);
      lx = a + 40;
      parts.push(`<text class="tb-step-l" x="${lx}" y="${y + 4}">${esc(s.label)}</text>`);
      if (s.note) parts.push(`<text class="tb-step-note" x="${lx}" y="${y + 17}">${esc(s.note)}</text>`);
    } else {
      const dir = z > a ? 1 : -1;
      parts.push(`<path class="tb-e tb-e-${tone}" d="M${a + dir * 4},${y} L${z - dir * 6},${y}" marker-end="url(#tb-ah${mk}-${uid})"/>`);
      lx = (a + z) / 2;
      parts.push(`<text class="tb-step-l" x="${lx}" y="${y - 7}" text-anchor="middle">${esc(s.label)}</text>`);
      if (s.note) parts.push(`<text class="tb-step-note" x="${lx}" y="${y + 15}" text-anchor="middle">${esc(s.note)}</text>`);
      if (bad) parts.push(`<g class="tb-x"><circle cx="${z - dir * 18}" cy="${y}" r="8"/><path d="M${z - dir * 18 - 3.5},${y - 3.5} l7,7 M${z - dir * 18 + 3.5},${y - 3.5} l-7,7"/></g>`);
    }
    parts.push("</g>");
  });
  const ns = opts.standalone ? ` xmlns="http://www.w3.org/2000/svg"` : "";
  return `<svg${ns} class="tb-flow" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(f.heading)}">${parts.join("")}</svg>`;
}

/** Every picture of the brief as a file of its own: `{ name, svg }`, to attach to the ticket. */
export function briefSvgs(b: Brief): { name: string; svg: string }[] {
  const out: { name: string; svg: string }[] = [];
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  b.system?.views.forEach((v, i) => out.push({ name: `${b.key}.map-${i + 1}-${slug(v.id)}.svg`, svg: mapSvg(b.system!, i, { standalone: true, title: `${b.key} · ${v.label}` }) }));
  if (b.flow) out.push({ name: `${b.key}.flow.svg`, svg: flowSvg(b.flow, { standalone: true }) });
  return out;
}

// ---- HTML ----------------------------------------------------------------------------------

function badge(b: Brief, id: string | undefined): string {
  const f: Fact | undefined = id ? b.facts.find((x) => x.id === id) : undefined;
  if (!f) return "";
  return ` <span class="tb-badge tb-how-${f.how}" title="${esc(`${f.id} · ${f.how} (${HOW_MEANS[f.how]}): ${f.text} Source: ${f.source}${f.as_of ? `, ${f.as_of}` : ""}`)}">${BADGE[f.how]}</span>`;
}

/** One badge per kind of evidence, so two read facts show one R with both in its tooltip. */
function badges(b: Brief, ids: string[] | undefined): string {
  const found = (ids ?? []).map((id) => b.facts.find((f) => f.id === id)).filter((f): f is Fact => !!f);
  return (["verified", "read", "said", "inferred"] as const)
    .map((how) => {
      const fs = found.filter((f) => f.how === how);
      if (!fs.length) return "";
      const tip = fs.map((f) => `${f.id}: ${f.text} Source: ${f.source}`).join("\n");
      return ` <span class="tb-badge tb-how-${how}" title="${esc(`${how} (${HOW_MEANS[how]})\n${tip}`)}">${BADGE[how]}${fs.length > 1 ? `×${fs.length}` : ""}</span>`;
    })
    .join("");
}

/** Mono names break after a slash or a dash, not in the middle of a word. */
const breakable = (html: string) => html.split(/(<[^>]*>)/).map((part) => (part.startsWith("<") ? part : part.replace(/([/\-_.])(?=\S)/g, "$1<wbr>"))).join("");

const section = (cls: string, heading: string, body: string, lead = "") => `<section class="tb-sec ${cls}"><h2>${fmt(heading)}</h2>${lead ? `<p class="tb-lead">${lead}</p>` : ""}${body}</section>`;

function mapHtml(b: Brief, map: SystemMap, uid: string): string {
  const name = `tb-v-${uid}`;
  const views = map.views.slice(0, CAPS.views);
  const radios = views.map((_, i) => `<input type="radio" class="tb-radio" name="${name}" id="${name}-${i}"${i === 0 ? " checked" : ""}>`).join("");
  const tabs = views.map((v, i) => `<label for="${name}-${i}"><span class="tb-tab-n">${i + 1}</span>${fmt(v.label)}</label>`).join("");
  const states = viewStates(map);
  const panels = views
    .map((v: MapView, i) => {
      const st = states[i];
      const counts = (["new", "changed", "gone"] as const).map((s) => [s, [...st.values()].filter((x) => x === s).length] as const).filter(([, n]) => n);
      const legend = counts.length ? `<span class="tb-legend">${counts.map(([s, n]) => `<span class="tb-lg-${s}">${n} ${s === "gone" ? "removed" : s}</span>`).join("")}</span>` : "";
      const pins = (v.pins ?? []).length ? `<ol class="tb-pins">${(v.pins ?? []).map((p) => `<li><span class="tb-pin-n"></span><span>${fmt(p.text)}${badge(b, p.fact)}</span></li>`).join("")}</ol>` : "";
      return `<div class="tb-panel">${v.caption || legend ? `<p class="tb-caption">${fmt(v.caption)}${legend}</p>` : ""}<div class="tb-canvas">${mapSvg(map, i, { uid: `${uid}${i}` })}</div>${pins}</div>`;
    })
    .join("");
  return `<div class="tb-tabs">${radios}${views.length > 1 ? `<div class="tb-tablist" role="tablist">${tabs}</div>` : ""}<div class="tb-panels">${panels}</div></div>`;
}

const MARK: Record<string, [string, string]> = { "+": ["good", "✓"], "~": ["ok", "~"], "-": ["bad", "✕"] };

/**
 * The brief's page, without <html>: the dashboard puts it in a document card, the export in a file.
 * `glanceOnly` stops after "At a glance": the workspace shows that much until you open the brief.
 */
export function briefHtml(b: Brief, { glanceOnly = false }: { glanceOnly?: boolean } = {}): string {
  const uid = uidFor(b);
  const out: string[] = [];
  const minutes = Math.max(1, Math.round(visibleText(b).join(" ").split(/\s+/).length / 220));
  const links = (b.links ?? []).map((l) => link(l.label, l.url)).join(`<span class="tb-sep">·</span>`);
  out.push(
    `<header class="tb-head"><div class="tb-eyebrow"><span class="tb-key">${esc(b.key)}</span><span>Ticket brief · size ${esc(b.size)} · ${minutes} min read</span><span title="The day the facts were last checked. PR state and ticket status move.">facts checked ${esc(b.verified_on)}</span></div>`,
    `<h1 class="tb-title">${fmt(b.title)}</h1><p class="tb-ask">${fmt(b.ask)}</p>${links ? `<div class="tb-links">${links}</div>` : ""}</header>`,
  );

  const g = b.glance;
  if (g) {
    const shifts = `<div class="tb-shifts"><div class="tb-shift tb-shift-head"><span></span><span>Today</span><span></span><span>When done</span></div>${g.shifts.map((s) => `<div class="tb-shift"><span class="tb-what">${fmt(s.what)}</span><span class="tb-before">${fmt(s.before)}</span><span class="tb-arrow">→</span><span class="tb-after">${fmt(s.after)}</span></div>`).join("")}</div>`;
    const stats = g.numbers?.length ? `<div class="tb-stats">${g.numbers.map((s) => `<div class="tb-stat"><div class="tb-stat-v">${fmt(s.value)}</div><div class="tb-stat-l">${fmt(s.label)}${badge(b, s.fact)}</div></div>`).join("")}</div>` : "";
    const heads = g.headsups?.length
      ? `<h3 class="tb-h3">Heads-up: where the ticket and reality differ</h3><div class="tb-heads">${g.headsups
          .map((h, i) => `<article class="tb-headsup"><div class="tb-hu-n">${i + 1}</div><div><h4>${fmt(h.title)}</h4>${h.ticket_says ? `<p class="tb-says"><span>Ticket says</span>${fmt(h.ticket_says)}</p>` : ""}<p class="tb-reality">${h.ticket_says ? "<span>Reality</span>" : ""}${fmt(h.body)}${badges(b, h.facts)}</p></div></article>`)
          .join("")}</div>`
      : "";
    out.push(`<section class="tb-sec tb-glance"><h2>At a glance</h2>${shifts}${stats}${heads}</section>`);
  }
  if (glanceOnly) return `<div class="tb" data-size="${esc(b.size)}">${out.join("")}</div>`;

  if (b.system) out.push(section("tb-system", b.system.heading, mapHtml(b, b.system, uid)));
  if (b.flow) out.push(section("tb-flowsec", b.flow.heading, `<div class="tb-canvas">${flowSvg(b.flow, { uid: `${uid}f` })}</div>`));

  if (b.done) {
    const items = `<ul class="tb-done">${b.done.items.map((d) => `<li><span class="tb-box"></span><div><div class="tb-done-t">${fmt(d.text)}${badge(b, d.fact)}</div><div class="tb-prove"><span>Prove it</span>${fmt(d.verify)}</div></div></li>`).join("")}</ul>`;
    const ac = b.done.ac_review?.length
      ? `<h3 class="tb-h3">The acceptance criteria, checked</h3><div class="tb-ac">${b.done.ac_review.map((a) => `<div class="tb-ac-row"><span class="tb-verdict tb-v-${a.verdict}">${esc(a.verdict)}</span><span class="tb-ac-t">${fmt(a.ac)}</span><span class="tb-ac-n">${fmt(a.note)}</span></div>`).join("")}</div>`
      : "";
    out.push(section("tb-donesec", b.done.heading ?? DEFAULT_HEADING.done, items + ac));
  }

  if (b.path?.steps.length) {
    const steps = `<ol class="tb-path">${b.path.steps
      .map(
        (s, i) =>
          `<li class="tb-step tb-st-${s.state ?? "next"}"><span class="tb-step-dot">${s.state === "done" ? "✓" : i + 1}</span><div class="tb-step-body"><div class="tb-step-top"><strong>${fmt(s.title)}</strong>${s.date ? `<span class="tb-chip">${esc(s.date)}</span>` : ""}<span class="tb-chip ${s.human ? "tb-chip-human" : ""}">${s.human ? "only a human: " : ""}${fmt(s.who)}</span>${s.state === "now" ? `<span class="tb-chip tb-chip-now">now</span>` : ""}</div>${s.detail ? `<p>${fmt(s.detail)}</p>` : ""}${s.gate || s.undo ? `<div class="tb-gates">${s.gate ? `<span><b>Gate</b> ${fmt(s.gate)}</span>` : ""}${s.undo ? `<span><b>Undo</b> ${fmt(s.undo)}</span>` : ""}</div>` : ""}</div></li>`,
      )
      .join("")}</ol>`;
    out.push(section("tb-pathsec", b.path.heading ?? DEFAULT_HEADING.path, steps));
  }

  if (b.decisions && (b.decisions.major.length || b.decisions.minor?.length)) {
    const major = b.decisions.major
      .map((d) => {
        const head = `<tr><th></th>${d.criteria.map((c) => `<th>${fmt(c)}</th>`).join("")}</tr>`;
        const rows = d.options
          .map((o) => `<tr class="${o.recommended ? "tb-rec" : ""}"><th>${fmt(o.name)}${o.recommended ? `<span class="tb-rec-tag">recommended</span>` : ""}</th>${o.cells.map((c) => {
            const [cls, icon] = MARK[c[0]] ?? ["ok", "·"];
            return `<td class="tb-m-${cls}"><span class="tb-mi">${icon}</span>${fmt(c.slice(2))}</td>`;
          }).join("")}</tr>`)
          .join("");
        return `<article class="tb-decision"><div class="tb-dec-head"><h3>${fmt(d.question)}</h3><span class="tb-decider">Decider: <strong>${fmt(d.decider)}</strong></span></div><div class="tb-matrix-wrap"><table class="tb-matrix">${head}${rows}</table></div><p class="tb-why"><b>Why</b> ${fmt(d.why)}${badges(b, d.facts)}</p></article>`;
      })
      .join("");
    const minor = b.decisions.minor?.length
      ? `<details class="tb-more"><summary>${b.decisions.minor.length} smaller ${b.decisions.minor.length === 1 ? "call" : "calls"}, already made or low-stakes</summary><ul class="tb-minor">${b.decisions.minor.map((m) => `<li><span>${fmt(m.question)}</span> <strong>${fmt(m.call)}</strong>${m.decider ? ` <span class="tb-muted">(${fmt(m.decider)})</span>` : ""}</li>`).join("")}</ul></details>`
      : "";
    out.push(section("tb-decsec", b.decisions.heading ?? DEFAULT_HEADING.decisions, major + minor));
  }

  if (b.people?.rows.length) {
    const rows = `<div class="tb-people">${b.people.rows.map((p) => `<div class="tb-person"><span class="tb-who">${fmt(p.who)}</span><span class="tb-before">${fmt(p.before)}</span><span class="tb-arrow">→</span><span class="tb-after">${fmt(p.after)}</span></div>`).join("")}</div>`;
    out.push(section("tb-peoplesec", b.people.heading ?? DEFAULT_HEADING.people, rows));
  }

  if (b.work) {
    const WHO: Record<string, string> = { agent: "an agent can do it", human: "only a human", either: "agent or human" };
    const repos = `<div class="tb-repos">${b.work.repos
      .map(
        (r) =>
          `<article class="tb-repo"><div class="tb-repo-top"><span class="tb-repo-name">${breakable(link(r.repo, r.url))}</span><span class="tb-chip tb-who-${esc(r.who)}">${WHO[r.who] ?? esc(r.who)}</span></div><p>${fmt(r.why)}</p>${r.paths.length ? `<ul class="tb-paths">${r.paths.map((p) => `<li>${breakable(fmt(p.includes("`") ? p : `\`${p}\``))}</li>`).join("")}</ul>` : ""}${r.pr ? `<div class="tb-pr">${link(r.pr.label, r.pr.url)}<span class="tb-pr-state tb-pr-${esc(r.pr.state)}">${esc(r.pr.state)}</span></div>` : ""}${r.human_only ? `<p class="tb-human"><b>Only a human</b> ${fmt(r.human_only)}</p>` : ""}</article>`,
      )
      .join("")}</div>`;
    out.push(section("tb-worksec", b.work.heading ?? DEFAULT_HEADING.work, `<div class="tb-first"><span>First move</span>${fmt(b.work.first_move)}</div>${repos}`));
  }

  if (b.risks && (b.risks.items.length || b.risks.questions?.length)) {
    const item = (r: (typeof b.risks.items)[number]) => `<li><div>${fmt(r.text)}${badge(b, r.fact)}</div>${r.mitigation ? `<div class="tb-mit">${fmt(r.mitigation)}</div>` : ""}</li>`;
    const top = b.risks.items.slice(0, CAPS.risksShown);
    const rest = b.risks.items.slice(CAPS.risksShown);
    const qs = b.risks.questions?.length ? `<h3 class="tb-h3">Open questions</h3><ul class="tb-questions">${b.risks.questions.map((q) => `<li>${fmt(q.q)} <span class="tb-chip">${fmt(q.owner)}</span></li>`).join("")}</ul>` : "";
    out.push(section("tb-risksec", b.risks.heading ?? DEFAULT_HEADING.risks, `${top.length ? `<ol class="tb-risks">${top.map(item).join("")}</ol>` : ""}${rest.length ? `<details class="tb-more"><summary>${rest.length} more ${rest.length === 1 ? "risk" : "risks"}</summary><ol class="tb-risks" start="${top.length + 1}">${rest.map(item).join("")}</ol></details>` : ""}${qs}`));
  }

  const counts = (["verified", "read", "said", "inferred"] as const).map((h) => [h, b.facts.filter((f) => f.how === h).length] as const).filter(([, n]) => n);
  const ledger = `<table class="tb-ledger"><tr><th></th><th>Fact</th><th>Source</th></tr>${b.facts.map((f) => `<tr><td><span class="tb-badge tb-how-${f.how}" title="${f.how}: ${HOW_MEANS[f.how]}">${BADGE[f.how]}</span> <span class="tb-fid">${esc(f.id)}</span></td><td>${fmt(f.text)}</td><td class="tb-src">${fmt(f.source)}${f.as_of ? ` <span class="tb-muted">${esc(f.as_of)}</span>` : ""}</td></tr>`).join("")}</table>`;
  const glossary = b.glossary?.length ? `<h3 class="tb-h3">Words used here</h3><dl class="tb-gloss">${b.glossary.map((x) => `<dt>${fmt(x.term)}</dt><dd>${fmt(x.means)}</dd>`).join("")}</dl>` : "";
  out.push(
    `<details class="tb-sec tb-evidence"><summary><h2>Evidence</h2><span class="tb-muted">${b.facts.length} facts: ${counts.map(([h, n]) => `${n} ${h}`).join(", ")}</span></summary><p class="tb-key-line">${(["verified", "read", "said", "inferred"] as const).map((h) => `<span class="tb-badge tb-how-${h}">${BADGE[h]}</span> ${h}: ${HOW_MEANS[h]}`).join(" &nbsp; ")}</p>${ledger}${glossary}</details>`,
  );
  return `<div class="tb" data-size="${esc(b.size)}">${out.join("")}</div>`;
}

/** The brief as one HTML file with no script and no outside request: to attach to the Jira ticket. */
export function briefDocument(b: Brief): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${esc(b.key)} brief: ${esc(b.title)}</title><style>${EXPORT_ROOT}${BRIEF_CSS}${SVG_THEME}</style></head><body><main class="tb-page">${briefHtml(b)}</main></body></html>\n`;
}

/** The dashboard's colors, for the exported file. */
const EXPORT_ROOT = `
:root{--bg:#f4f3ef;--surface:#fff;--ink:#16161a;--ink-2:#3c3c43;--muted:#86868b;--line:#e2e0da;--line-2:#d4d2cb;--hover:#00000008;--working:#2f6feb;--working-bg:#eaf1fe;--bad:#d92d20;--bad-bg:#fdecea;--warn:#b7791f;--warn-bg:#fbf3e2;--good:#12925b;--good-bg:#e6f5ee;--shadow:0 1px 2px #0000000a,0 4px 16px #0000000a;--radius:14px;--sans:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--display:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace;font:14px/1.5 var(--sans);color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--surface:#1c1c1f;--ink:#f2f2f3;--ink-2:#c7c7cc;--muted:#8e8e93;--line:#2a2a2e;--line-2:#38383d;--hover:#ffffff0a;--working:#5b8ff9;--working-bg:#5b8ff91a;--bad:#ff6b5e;--bad-bg:#ff6b5e1a;--warn:#e0a84a;--warn-bg:#e0a84a1a;--good:#3ccf8e;--good-bg:#3ccf8e1a}}
*{box-sizing:border-box}body{margin:0}.tb-page{max-width:980px;margin:0 auto;padding:32px 24px 64px}
code{font:12.5px var(--mono);background:var(--hover);padding:1px 5px;border-radius:5px}a{color:inherit}
`;

/** The map's colors on a page: the theme's, so the map follows dark mode. */
export const SVG_THEME = `
.tb .tb-n rect,.tb .tb-n path.tb-shape{fill:var(--surface);stroke:var(--ink-2);stroke-width:1.3}
.tb .tb-k-external rect{stroke-dasharray:5 4}
.tb .tb-k-actor rect{fill:var(--bg)}
.tb .tb-s-new rect,.tb .tb-s-new path.tb-shape{stroke:var(--good);stroke-width:2.2;fill:var(--good-bg)}
.tb .tb-s-changed rect,.tb .tb-s-changed path.tb-shape{stroke:var(--warn);stroke-width:2.2;fill:var(--warn-bg)}
.tb .tb-s-gone{opacity:.42}
.tb .tb-s-gone rect,.tb .tb-s-gone path.tb-shape{stroke-dasharray:4 4}
.tb .tb-nl{font:600 14.5px var(--sans);fill:var(--ink)}
.tb .tb-ns{font:12px var(--sans);fill:var(--ink-2);opacity:.8}
.tb .tb-tag rect{stroke:none}
.tb .tb-tag text{font:700 9px var(--sans);letter-spacing:.06em;fill:#fff}
.tb .tb-tag-new rect{fill:var(--good)}.tb .tb-tag-changed rect{fill:var(--warn)}.tb .tb-tag-gone rect{fill:var(--muted)}
.tb .tb-e{fill:none;stroke:var(--muted);stroke-width:1.5}
.tb .tb-e-bad{stroke:var(--bad);stroke-width:2}
.tb .tb-e-new{stroke:var(--good);stroke-width:2}
.tb .tb-e-dashed{stroke-dasharray:5 4}
.tb .tb-ah{fill:var(--muted)}.tb .tb-ah-bad{fill:var(--bad)}.tb .tb-ah-new{fill:var(--good)}
.tb .tb-el rect{fill:var(--surface);stroke:none;opacity:.94}
.tb .tb-el text{font:12px var(--sans);fill:var(--ink-2)}
.tb .tb-el-bad text{fill:var(--bad);font-weight:600}
.tb .tb-pin circle{fill:var(--bad);stroke:var(--surface);stroke-width:2}
.tb .tb-pin text{font:700 11px var(--sans);fill:#fff}
.tb .tb-lane rect{fill:var(--bg);stroke:var(--ink-2);stroke-width:1.2}
.tb .tb-lane text{font:600 12px var(--sans);fill:var(--ink)}
.tb .tb-life{stroke:var(--line-2);stroke-width:1.2;stroke-dasharray:4 4}
.tb .tb-step-n{font:600 11px var(--mono);fill:var(--muted)}
.tb .tb-step-l{font:12px var(--sans);fill:var(--ink)}
.tb .tb-step-note{font:11px var(--sans);fill:var(--muted)}
.tb .tb-step-bad .tb-step-l,.tb .tb-step-bad .tb-step-note{fill:var(--bad)}
.tb .tb-x circle{fill:var(--bad)}.tb .tb-x path{stroke:#fff;stroke-width:2}
`;

/** The page's layout. It reads the dashboard's color variables, so it matches the theme. */
export const BRIEF_CSS = `
.tb{--tb-gap:28px;color:var(--ink);max-width:960px}
.tb h2{font:650 19px/1.3 var(--display);margin:0 0 14px;letter-spacing:-.01em}
.tb h3,.tb h4{margin:0}
.tb p{margin:0}
.tb-muted{color:var(--muted)}
.tb-sep{color:var(--line-2);margin:0 8px}
.tb-sec{margin-top:var(--tb-gap);padding-top:var(--tb-gap);border-top:1px solid var(--line)}
.tb-h3{font:600 13px var(--sans);color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:22px 0 10px!important}
.tb-head{padding-bottom:4px}
.tb-eyebrow{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);align-items:center}
.tb-key{font:600 12px var(--mono);color:var(--ink);background:var(--hover);padding:2px 8px;border-radius:6px}
.tb-title{font:700 26px/1.2 var(--display);letter-spacing:-.02em;margin:10px 0 10px}
.tb-ask{font-size:17px;line-height:1.5;color:var(--ink-2);max-width:760px}
.tb-links{margin-top:10px;font-size:13px}
.tb-shifts{display:grid;gap:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface)}
.tb-shift{display:grid;grid-template-columns:minmax(110px,.8fr) 1.5fr 24px 1.5fr;gap:12px;padding:10px 14px;border-top:1px solid var(--line);align-items:baseline}
.tb-shift:first-child{border-top:0}
.tb-shift-head{font-size:11.5px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;padding:8px 14px;background:var(--hover)}
.tb-what,.tb-who{font-weight:600}
.tb-before{color:var(--muted)}
.tb-after{color:var(--ink)}
.tb-arrow{color:var(--muted);text-align:center}
.tb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:14px}
.tb-stat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 16px}
.tb-stat-v{font:700 28px/1.1 var(--display);letter-spacing:-.02em}
.tb-stat-l{font-size:12.5px;color:var(--ink-2);margin-top:4px}
.tb-heads{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
.tb-headsup{display:flex;gap:12px;background:var(--warn-bg);border:1px solid color-mix(in srgb,var(--warn) 30%,transparent);border-radius:12px;padding:12px 14px}
.tb-hu-n{flex:none;width:22px;height:22px;border-radius:50%;background:var(--warn);color:#fff;font:700 12px/22px var(--sans);text-align:center}
.tb-headsup h4{font:600 14.5px/1.35 var(--sans);margin-bottom:6px}
.tb-headsup p{font-size:13px;line-height:1.5}
.tb-says{color:var(--muted);margin-bottom:4px!important}
.tb-says span,.tb-reality span{display:inline-block;font:700 10px var(--sans);letter-spacing:.06em;text-transform:uppercase;margin-right:6px;padding:1px 6px;border-radius:4px;background:var(--hover)}
.tb-reality span{background:var(--warn);color:#fff}
.tb-says{text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--muted) 60%,transparent)}
.tb-says span{text-decoration:none}
.tb-tabs{position:relative}
.tb-radio{position:absolute;top:0;left:0;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}
.tb-tablist{display:inline-flex;gap:4px;padding:4px;background:var(--hover);border:1px solid var(--line);border-radius:10px;margin-bottom:12px}
.tb-tablist label{display:inline-flex;align-items:center;gap:7px;padding:5px 14px;border-radius:7px;font-size:13px;font-weight:500;color:var(--ink-2);cursor:pointer;user-select:none}
.tb-tablist label:hover{background:var(--surface)}
.tb-tab-n{font:600 10.5px var(--mono);color:var(--muted)}
.tb-panel{display:none}
${[1, 2, 3, 4].map((i) => `.tb-tabs>.tb-radio:nth-of-type(${i}):checked~.tb-panels>.tb-panel:nth-child(${i}){display:block}.tb-tabs>.tb-radio:nth-of-type(${i}):checked~.tb-tablist>label:nth-child(${i}){background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}.tb-tabs>.tb-radio:nth-of-type(${i}):focus-visible~.tb-tablist>label:nth-child(${i}){outline:2px solid var(--working)}`).join("")}
.tb-caption{font-size:13.5px;color:var(--ink-2);margin-bottom:10px!important;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline}
.tb-legend{display:inline-flex;gap:10px;font-size:11.5px;font-weight:600}
.tb-legend>span{padding:1px 8px;border-radius:999px}
.tb-lg-new{background:var(--good-bg);color:var(--good)}.tb-lg-changed{background:var(--warn-bg);color:var(--warn)}.tb-lg-gone{background:var(--hover);color:var(--muted)}
.tb-canvas{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow-x:auto}
.tb-canvas svg{display:block;max-width:100%;height:auto;margin:0 auto}
.tb-pins{list-style:none;padding:0;margin:12px 0 0;counter-reset:pin;display:grid;gap:6px}
.tb-pins li{display:flex;gap:10px;font-size:13.5px;align-items:baseline;counter-increment:pin}
.tb-pin-n{flex:none;width:20px;height:20px;border-radius:50%;background:var(--bad);color:#fff;font:700 11px/20px var(--sans);text-align:center;position:relative;top:-1px}
.tb-pin-n::before{content:counter(pin)}
.tb-done{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.tb-done li{display:flex;gap:12px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.tb-box{flex:none;width:16px;height:16px;border:1.6px solid var(--line-2);border-radius:4px;margin-top:3px}
.tb-done-t{font-weight:550}
.tb-prove{font-size:12.5px;color:var(--ink-2);margin-top:4px}
.tb-prove>span,.tb-gates b,.tb-why b,.tb-human b,.tb-first>span{font:700 10px var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-right:8px}
.tb-ac{display:grid;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.tb-ac-row{display:grid;grid-template-columns:72px 1fr 1.2fr;gap:12px;padding:8px 12px;border-top:1px solid var(--line);font-size:13px;align-items:baseline}
.tb-ac-row:first-child{border-top:0}
.tb-ac-n{color:var(--ink-2)}
.tb-verdict{font:700 10px var(--sans);letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:5px;text-align:center}
.tb-v-ok{background:var(--good-bg);color:var(--good)}.tb-v-change{background:var(--warn-bg);color:var(--warn)}.tb-v-drop{background:var(--bad-bg);color:var(--bad)}.tb-v-add{background:var(--working-bg);color:var(--working)}
.tb-path{list-style:none;padding:0;margin:0;position:relative}
.tb-step{display:flex;gap:14px;position:relative;padding-bottom:16px}
.tb-step:not(:last-child)::before{content:"";position:absolute;left:13px;top:28px;bottom:0;width:2px;background:var(--line)}
.tb-step-dot{flex:none;width:28px;height:28px;border-radius:50%;border:2px solid var(--line-2);background:var(--surface);font:700 12px/24px var(--sans);text-align:center;color:var(--ink-2);z-index:1}
.tb-st-done .tb-step-dot{background:var(--good);border-color:var(--good);color:#fff}
.tb-st-now .tb-step-dot{border-color:var(--working);color:var(--working)}
.tb-step-body{flex:1;min-width:0;padding-top:3px}
.tb-step-top{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center}
.tb-step-body p{font-size:13.5px;color:var(--ink-2);margin-top:4px}
.tb-gates{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:12.5px;margin-top:6px;color:var(--ink-2)}
.tb-chip{display:inline-block;font-size:11.5px;font-weight:500;padding:1px 8px;border-radius:999px;border:1px solid var(--line-2);color:var(--ink-2);white-space:nowrap}
.tb-chip-human,.tb-who-human{border-color:transparent;background:var(--warn-bg);color:var(--warn);font-weight:600}
.tb-chip-now{border-color:transparent;background:var(--working-bg);color:var(--working);font-weight:600}
.tb-who-agent{border-color:transparent;background:var(--good-bg);color:var(--good)}
.tb-decision{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:14px}
.tb-dec-head{display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.tb-dec-head h3{font:600 15px/1.35 var(--sans)}
.tb-decider{font-size:12.5px;color:var(--ink-2);white-space:nowrap}
.tb-matrix-wrap{overflow-x:auto}
.tb-matrix{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}
.tb-matrix th,.tb-matrix td{padding:8px 10px;text-align:left;vertical-align:top;border-top:1px solid var(--line)}
.tb-matrix tr:first-child th{border-top:0;font-size:11.5px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.tb-matrix tr>th:first-child{font-weight:600;min-width:130px}
.tb-rec>*{background:color-mix(in srgb,var(--good) 7%,transparent)}
.tb-rec>th:first-child{box-shadow:inset 3px 0 0 var(--good)}
.tb-rec-tag{display:block;font:700 9.5px var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--good);margin-top:3px}
.tb-mi{display:inline-block;width:16px;font-weight:700}
.tb-m-good .tb-mi{color:var(--good)}.tb-m-ok .tb-mi{color:var(--warn)}.tb-m-bad .tb-mi{color:var(--bad)}
.tb-m-bad{color:var(--ink-2)}
.tb-why{font-size:13px;color:var(--ink-2);margin-top:10px!important}
.tb-more{margin-top:6px}
.tb-more>summary{cursor:pointer;font-size:13px;color:var(--muted);padding:6px 0}
.tb-minor{margin:4px 0 0;padding-left:20px;font-size:13px;display:grid;gap:4px}
.tb-people{display:grid;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface)}
.tb-person{display:grid;grid-template-columns:minmax(120px,.8fr) 1.5fr 24px 1.5fr;gap:12px;padding:10px 14px;border-top:1px solid var(--line);font-size:13.5px;align-items:baseline}
.tb-person:first-child{border-top:0}
.tb-first{background:var(--working-bg);border-radius:10px;padding:10px 14px;font-size:14px;margin-bottom:14px}
.tb-first>span{color:var(--working)}
.tb-repos{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.tb-repo{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:13px;display:flex;flex-direction:column;gap:6px}
.tb-repo-top{display:flex;gap:8px;justify-content:space-between;align-items:baseline}
.tb-repo-name{font:600 13px var(--mono);min-width:0}
.tb-paths{list-style:none;padding:0;margin:0;display:grid;gap:3px}
.tb-paths code{font-size:11.5px}
.tb-pr{display:flex;gap:8px;align-items:center}
.tb-pr-state{font:700 10px var(--sans);letter-spacing:.06em;text-transform:uppercase;padding:1px 7px;border-radius:5px}
.tb-pr-open{background:var(--working-bg);color:var(--working)}.tb-pr-draft{background:var(--hover);color:var(--muted)}.tb-pr-merged{background:var(--good-bg);color:var(--good)}.tb-pr-closed{background:var(--bad-bg);color:var(--bad)}
.tb-human{background:var(--warn-bg);border-radius:8px;padding:6px 10px}
.tb-human b{color:var(--warn)}
.tb-risks{margin:0;padding-left:22px;display:grid;gap:8px;font-size:13.5px}
.tb-mit{color:var(--muted);font-size:12.5px}
.tb-questions{margin:0;padding-left:20px;display:grid;gap:6px;font-size:13.5px}
.tb-evidence>summary{cursor:pointer;display:flex;gap:12px;align-items:baseline;list-style:none}
.tb-evidence>summary::-webkit-details-marker{display:none}
.tb-evidence>summary h2{margin:0}
.tb-evidence>summary::before{content:"▸";color:var(--muted)}
.tb-evidence[open]>summary::before{content:"▾"}
.tb-key-line{font-size:12px;color:var(--muted);margin:12px 0!important}
.tb-ledger{width:100%;border-collapse:collapse;font-size:12.5px}
.tb-ledger th,.tb-ledger td{text-align:left;vertical-align:top;padding:6px 8px;border-top:1px solid var(--line)}
.tb-ledger th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.tb-ledger td:first-child{white-space:nowrap}
.tb-src{color:var(--ink-2);width:34%}
.tb-fid{font:11px var(--mono);color:var(--muted)}
.tb-gloss{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;font-size:13px;margin:0}
.tb-gloss dt{font-weight:600}.tb-gloss dd{margin:0;color:var(--ink-2)}
.tb-badge{display:inline-block;min-width:16px;height:16px;padding:0 4px;border-radius:4px;font:700 10px/16px var(--mono);text-align:center;vertical-align:1px;cursor:help}
.tb-how-verified{background:var(--good-bg);color:var(--good)}
.tb-how-read{background:var(--working-bg);color:var(--working)}
.tb-how-said{background:var(--warn-bg);color:var(--warn)}
.tb-how-inferred{background:var(--hover);color:var(--muted);box-shadow:inset 0 0 0 1px var(--line-2)}
@media (max-width:640px){.tb-shift,.tb-person{grid-template-columns:1fr}.tb-shift-head{display:none}.tb-arrow{display:none}.tb-ac-row{grid-template-columns:64px 1fr}.tb-ac-n{grid-column:2}}
`;
