import { useEffect, useMemo, useRef, useState } from "react";
import type { Dashboard, Diagram, DiagramKind, DiagramWithSource } from "../../shared/types.ts";
import { age, api, dirLabel, plural, stamp } from "./lib.tsx";
import { Mermaid } from "./mermaid.tsx";
import { href, humanAge } from "./routes.ts";

/** The diagram page (`#/d:ID`), the list (`#/diagrams`), and the cards on the board. */

const KIND_LABEL: Record<DiagramKind, string> = { mermaid: "mermaid", svg: "SVG", png: "PNG", jpeg: "JPEG", gif: "GIF", webp: "WebP" };

const raw = (d: Diagram) => `/api/diagram/raw?id=${d.id}`;

/** A preview needs only the source, which never changes, so each one loads once. */
const sources = new Map<number, Promise<string | null>>();
function sourceOf(id: number): Promise<string | null> {
  let p = sources.get(id);
  if (!p) {
    p = api.diagram(id).then((d) => d.source);
    p.catch(() => sources.delete(id));
    sources.set(id, p);
  }
  return p;
}

/** Turns true near the screen, so a long list renders only what you scroll to. */
function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible || !ref.current) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "300px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible]);
  return [ref, visible];
}

function DiagramPreview({ d }: { d: Diagram }) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const [code, setCode] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (visible && d.kind === "mermaid") sourceOf(d.id).then(setCode, () => setFailed(true));
  }, [visible, d.id, d.kind]);
  return (
    <div ref={ref} className="diagram-preview">
      {!visible ? null : d.kind !== "mermaid" ? <img src={raw(d)} alt={d.title} /> : code ? <Mermaid code={code} /> : failed ? <span className="meta">Could not load it.</span> : <span className="shimmer" />}
    </div>
  );
}

export function DiagramCards({ diagrams, now, showTicket = false, showConversation = false }: { diagrams: Diagram[]; now: number; showTicket?: boolean; showConversation?: boolean }) {
  return (
    <div className="diagram-grid">
      {diagrams.map((d) => (
        <article key={d.id} className="diagram-card" id={`d:${d.id}`}>
          <a className="diagram-card-preview" href={href(`d:${d.id}`)} aria-label={`Open diagram ${d.id}: ${d.title}`}>
            <DiagramPreview d={d} />
          </a>
          <div className="diagram-card-meta">
            <a className="diagram-card-title" href={href(`d:${d.id}`)} title={d.title}>
              {d.title}
            </a>
            <div className="diagram-card-tags">
              <span className="tag tone-muted">{KIND_LABEL[d.kind]}</span>
              {showTicket && d.ticket && (
                <a className="key-link" href={href(`t:${d.ticket}`)} title="Open the ticket on the board">
                  {d.ticket}
                </a>
              )}
              {showConversation && (
                <a className="meta" href={href(`c:${d.sessionId}`)} title="Open the conversation that made it">
                  conversation
                </a>
              )}
              <span className="grow" />
              <span className="meta" title={stamp(d.createdAt)}>
                {age(d.createdAt, now)}
              </span>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

/** Reads only the stored row, so it opens without its conversation or ticket. */
export function DiagramView({ id, data, now }: { id: number; data: Dashboard; now: number }) {
  const [d, setD] = useState<DiagramWithSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    setD(null);
    setError(null);
    api.diagram(id).then(setD, (err: Error) => setError(err.message));
  }, [id]);
  // The page loads once; the live listing has the ticket if it moved since.
  const ticketKey = data.diagrams.find((x) => x.id === id)?.ticket ?? d?.ticket ?? null;
  const ticket = useMemo(() => [...data.myTickets, ...data.otherTickets].find((g) => g.ticket.key === ticketKey)?.ticket, [data, ticketKey]);
  const siblings = d ? data.diagrams.filter((x) => x.sessionId === d.sessionId && x.id !== d.id) : [];

  if (error) return <article className="workspace"><div className="zero big">Diagram {id}: {error}</div></article>;
  if (!d) return <article className="workspace"><span className="shimmer wide" /></article>;
  return (
    <article className="workspace">
      <header className="ws-head">
        <div className="eyebrow">
          <span>Diagram {d.id}</span>
          <span className="tag tone-muted">{KIND_LABEL[d.kind]}</span>
        </div>
        <h1>{d.title}</h1>
        <div className="ws-meta diagram-links">
          {ticketKey ? (
            <a className="key-link" href={href(`t:${ticketKey}`)} title="Open the ticket on the board">
              {ticketKey}
            </a>
          ) : (
            <span className="meta">no ticket</span>
          )}
          {ticket && <span className="meta">{ticket.summary}</span>}
          <span className="sep">·</span>
          <a href={href(`c:${d.sessionId}`)} title="Open the conversation that made it">
            {d.conversation ? d.conversation.title.slice(0, 80) : `conversation ${d.sessionId.slice(-6)}`}
          </a>
          {d.conversation && <span className="meta">in {dirLabel(d.conversation.cwd)}</span>}
          <span className="sep">·</span>
          <span className="meta" title={stamp(d.createdAt)}>
            made {humanAge(d.createdAt, now) === "just now" ? "just now" : `${humanAge(d.createdAt, now)} ago`}
          </span>
          {d.origin !== "reply" && (
            <span className="meta" title={d.origin}>
              from <code>{d.origin.split("/").pop()}</code>
            </span>
          )}
          <span className="grow" />
          {d.source !== null && (
            <button className="btn ghost small" onClick={() => setShowSource(!showSource)}>
              {showSource ? "Hide the source" : "Show the source"}
            </button>
          )}
          <a className="btn ghost small" href={raw(d)} target="_blank" rel="noreferrer" title="Open the stored file in a new tab">
            Open the file ↗
          </a>
        </div>
      </header>
      <section className="card diagram-full">{d.kind === "mermaid" ? <Mermaid code={d.source ?? ""} /> : <img src={raw(d)} alt={d.title} />}</section>
      {showSource && d.source !== null && <pre className="diagram-source">{d.source}</pre>}
      {siblings.length > 0 && (
        <div className="stack">
          <h2 className="section-title">More from this conversation · {siblings.length}</h2>
          <DiagramCards diagrams={siblings} now={now} />
        </div>
      )}
    </article>
  );
}

/** `#/diagrams`: every diagram, newest first. */
export function DiagramsView({ data, now }: { data: Dashboard; now: number }) {
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = data.diagrams.filter((d) => words.every((w) => `${d.title} ${d.ticket ?? ""} ${d.kind} ${d.origin}`.toLowerCase().includes(w)));
  const conversations = new Set(data.diagrams.map((d) => d.sessionId)).size;
  return (
    <article className="workspace">
      <header className="ws-head">
        <h1>Diagrams</h1>
        <div className="ws-meta">
          <span className="meta">
            {plural(data.diagrams.length, "diagram")} from {plural(conversations, "conversation")} · newest first
          </span>
        </div>
        <input className="search" type="search" placeholder="Search titles, tickets, kinds, files" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>
      {found.length === 0 ? (
        <div className="zero big">{query ? "No diagram matches." : "No diagrams yet. An agent's mermaid fences, the .mmd and .svg files it writes, and the images it embeds with ![title](path) show here."}</div>
      ) : (
        <DiagramCards diagrams={found} now={now} showTicket showConversation />
      )}
    </article>
  );
}
