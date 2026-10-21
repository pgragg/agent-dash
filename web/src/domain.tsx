import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { contextTone, lookup, type Registry, TERM_HELP, TERM_KINDS, type TermKind } from "../../shared/terms.ts";
import { inline } from "./lib.tsx";

/** The registry of the document that is rendering, so that each mark in it can find its card. */
const DomainContext = createContext<Registry | null>(null);

export function DomainScope({ registry, children }: { registry: Registry | null; children: ReactNode }) {
  const outer = useContext(DomainContext);
  return <DomainContext.Provider value={registry ?? outer}>{children}</DomainContext.Provider>;
}

export const useRegistry = () => useContext(DomainContext);

/** A long `table.column` name may wrap after a dot, an underscore or a slash, and nowhere else. */
function breakable(name: string): ReactNode[] {
  return name.split(/(?<=[._/])/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));
}

function ContextChip({ registry, id }: { registry: Registry; id: string }) {
  return <span className={`ctx-chip ctx-${contextTone(registry, id) ?? "none"}`}>{registry.contexts[id]?.name ?? id}</span>;
}

/** What a reader needs to place a term: its kind, owner, context, source, and what it is. */
function Card({ registry, kind, name }: { registry: Registry; kind: TermKind; name: string }) {
  if (kind === "svc" || kind === "ctx") {
    const it = kind === "svc" ? registry.services[name] : registry.contexts[name];
    const stores = kind === "svc" ? Object.values(registry.services[name]?.stores ?? {}) : [];
    return (
      <>
        <div className="term-card-kind">{TERM_KINDS[kind]}</div>
        <div className="term-card-name">{it?.name ?? name}</div>
        {it?.about && <p>{inline(it.about)}</p>}
        {stores.length > 0 && <p className="meta">Stores: {stores.join(", ")}</p>}
      </>
    );
  }
  const hit = lookup(registry, name);
  if (!hit) return <><div className="term-card-kind">{TERM_KINDS[kind]}</div><div className="term-card-name">{name}</div><p className="meta">This document's registry does not have this term.</p></>;
  const { base, term } = hit;
  const svc = term.service ? registry.services[term.service] : undefined;
  return (
    <>
      <div className="term-card-kind">
        {TERM_KINDS[term.kind]}
        {term.context && <ContextChip registry={registry} id={term.context} />}
      </div>
      <div className="term-card-name">{term.kind === "rule" ? `${base}: ${term.name}` : name}</div>
      {base !== name && <p className="meta">A field of {base}.</p>}
      {svc && <p className="meta">Owner: {svc.name}{term.store ? ` › ${svc.stores?.[term.store] ?? term.store}` : ""}</p>}
      {term.about && <p>{inline(term.about)}</p>}
      {term.copyOf && <p className="term-card-copy">A copy of {term.copyOf}.{term.sync ? ` ${term.sync}` : ""}</p>}
      {term.key && <p className="term-card-key">🔑 An identity key: it joins records across contexts.</p>}
      {term.code && <p className="term-card-code">{term.code}</p>}
    </>
  );
}

/** A marked noun: colored by its kind, with its card on hover or focus. */
export function TermMark({ kind, name }: { kind: TermKind; name: string }) {
  const registry = useContext(DomainContext);
  const [at, setAt] = useState<DOMRect | null>(null);
  const hit = registry && kind !== "svc" && kind !== "ctx" ? lookup(registry, name) : null;
  const term = hit?.term;
  const cls = ["term", `term-${kind}`, term?.copyOf && "term-copy", term?.key && "term-key", kind === "ctx" && registry && `ctx-${contextTone(registry, name) ?? "none"}`].filter(Boolean).join(" ");
  const label =
    kind === "svc" ? (registry?.services[name]?.name ?? name)
    : kind === "ctx" ? (registry?.contexts[name]?.name ?? name)
    : breakable(name);
  const ns = kind === "rec" && term?.service ? `${term.service}›${term.store ?? "?"}` : null;
  if (!registry) return <code className={cls} title={TERM_KINDS[kind]}>{label}</code>;
  const show = (e: { currentTarget: HTMLElement }) => setAt(e.currentTarget.getBoundingClientRect());
  return (
    <>
      <code className={cls} tabIndex={0} onMouseEnter={show} onFocus={show} onMouseLeave={() => setAt(null)} onBlur={() => setAt(null)}>
        {ns && <span className="term-ns">{ns}</span>}
        {label}
      </code>
      {at &&
        createPortal(
          <div className="term-card" role="tooltip" style={{ top: Math.min(at.bottom + 6, innerHeight - 40), left: Math.max(8, Math.min(at.left, innerWidth - 348)) }}>
            <Card registry={registry} kind={kind} name={name} />
          </div>,
          document.body,
        )}
    </>
  );
}

const SAMPLE: Record<TermKind, string> = { rec: "Table.column", fn: "method", obj: "Type.field", rule: "R1", svc: "Service", ctx: "Context", ext: "Actor" };

/** The ```domain fence renders as the page's legend: how to read the marks, then the contexts, services and rules. */
export function DomainLegend({ registry, error }: { registry: Registry | null; error?: string }) {
  if (!registry) return <div className="mermaid-error"><span className="meta">{error}</span></div>;
  const rules = Object.entries(registry.terms).filter(([, t]) => t.kind === "rule");
  return (
    <div className="domain-legend">
      <div className="md-table">
        <table>
          <tbody>
            <tr><th>Mark</th><th>Kind</th><th>What it is</th></tr>
            {(Object.keys(TERM_KINDS) as TermKind[]).map((k) => (
              <tr key={k}>
                <td><code className={`term term-${k}${k === "ctx" ? " ctx-violet" : ""}`}>{SAMPLE[k]}</code></td>
                <td>{TERM_KINDS[k]}</td>
                <td>{TERM_HELP[k]}</td>
              </tr>
            ))}
            <tr><td><code className="term term-rec term-copy">Copy</code></td><td>Dashed border</td><td>A copy of other data. It can be late or wrong</td></tr>
            <tr><td><code className="term term-obj term-key">key</code></td><td>🔑</td><td>An identity key: it joins records across contexts</td></tr>
          </tbody>
        </table>
      </div>
      <p className="meta">Hover over a mark, or tab to it, to see its card. A colored rail on the left of a section shows its bounded context.</p>
      <div className="domain-legend-cols">
        <div>
          <h4 data-level={4}>Bounded contexts</h4>
          <ul>{Object.entries(registry.contexts).map(([id, c]) => <li key={id}><ContextChip registry={registry} id={id} /> {c.about && inline(c.about)}</li>)}</ul>
        </div>
        <div>
          <h4 data-level={4}>Services and their stores</h4>
          <ul>
            {Object.entries(registry.services).map(([id, s]) => (
              <li key={id}>
                <TermMark kind="svc" name={id} /> {s.about && inline(s.about)}
                {s.stores && Object.keys(s.stores).length > 0 && <span className="meta"> Stores: {Object.entries(s.stores).map(([k, v]) => `${id}›${k} (${v})`).join(", ")}.</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {rules.length > 0 && (
        <>
          <h4 data-level={4}>Rules</h4>
          <ul>{rules.map(([id, t]) => <li key={id}><TermMark kind="rule" name={id} /> {t.name}</li>)}</ul>
        </>
      )}
    </div>
  );
}

/** A section whose heading has a `ctx:` mark: a rail in the context's color down its left side. */
export function ContextRegion({ id, children }: { id: string; children: ReactNode }) {
  const registry = useContext(DomainContext);
  return <section className={`ctx-region ctx-${(registry && contextTone(registry, id)) ?? "none"}`}>{children}</section>;
}
