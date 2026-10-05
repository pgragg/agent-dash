import { useEffect, useMemo, useRef, useState } from "react";
import type { Dashboard, Diagram, DiagramKind, DiagramWithSource } from "../../shared/types.ts";
import { age, api, dirLabel, plural, stamp } from "./lib.tsx";
import { Mermaid, rawUrl as raw } from "./mermaid.tsx";
import { href, humanAge } from "./routes.ts";

/** The diagram page (`#/d:ID`), the list (`#/diagrams`), and the cards on the board. */

const ago = (iso: string, now: number) => (humanAge(iso, now) === "just now" ? "just now" : `${humanAge(iso, now)} ago`);

const KIND_LABEL: Record<DiagramKind, string> = { mermaid: "mermaid", svg: "SVG", png: "PNG", jpeg: "JPEG", gif: "GIF", webp: "WebP" };

/** A preview needs only the source, which changes only with an edit, so each version loads once. */
const sources = new Map<string, Promise<string | null>>();
function sourceOf(d: Diagram): Promise<string | null> {
  const key = `${d.id} ${d.editedAt ?? ""}`;
  let p = sources.get(key);
  if (!p) {
    p = api.diagram(d.id).then((x) => x.source);
    p.catch(() => sources.delete(key));
    sources.set(key, p);
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
    if (visible && d.kind === "mermaid") sourceOf(d).then(setCode, () => setFailed(true));
  }, [visible, d.id, d.kind, d.editedAt]);
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

/** Waits for a pause in typing, so the preview does not render on each key. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Fixes an agent's mistake: the title of any diagram, and the source of a mermaid or SVG one. */
function DiagramEditor({ d, onDone }: { d: DiagramWithSource; onDone: (saved: DiagramWithSource | null) => void }) {
  const [title, setTitle] = useState(d.title);
  const [source, setSource] = useState(d.source ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useSettled(source, 300);
  const change = { ...(title.trim() !== d.title ? { title } : {}), ...(d.source !== null && source !== d.source ? { source } : {}) };
  const save = async () => {
    if (!Object.keys(change).length) return onDone(null);
    setBusy(true);
    setError(null);
    try {
      onDone(await api.editDiagram(d.id, change));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
    if (e.key === "Escape" && (!Object.keys(change).length || confirm("Throw away your changes?"))) onDone(null);
  };
  return (
    <section className="card diagram-editor" onKeyDown={keys}>
      <label>
        <span className="meta">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus />
      </label>
      {d.source !== null && (
        <div className="diagram-editor-panes">
          <label>
            <span className="meta">{d.kind === "mermaid" ? "Mermaid code" : "SVG"}</span>
            <textarea value={source} onChange={(e) => setSource(e.target.value)} spellCheck={false} />
          </label>
          <div className="diagram-editor-preview">
            <span className="meta">Preview</span>
            {/* An SVG in an <img> runs no script. */}
            {d.kind === "mermaid" ? <Mermaid code={preview} /> : <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`} alt="Preview" />}
          </div>
        </div>
      )}
      <div className="diagram-editor-actions">
        {error && <span className="error">{error}</span>}
        <span className="grow" />
        <button className="btn ghost small" onClick={() => onDone(null)} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary small" onClick={save} disabled={busy || !title.trim() || (d.source !== null && !source.trim())}>
          {busy ? "Saving…" : "Save"} <kbd>⌘↵</kbd>
        </button>
      </div>
    </section>
  );
}

/** Reads only the stored row, so it opens without its conversation or ticket. */
export function DiagramView({ id, data, now }: { id: number; data: Dashboard; now: number }) {
  const [d, setD] = useState<DiagramWithSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setD(null);
    setError(null);
    api.diagram(id).then(setD, (err: Error) => setError(err.message));
  }, [id]);
  // The page loads once; the live listing has the ticket if it moved since.
  const ticketKey = data.diagrams.find((x) => x.id === id)?.ticket ?? d?.ticket ?? null;
  const ticket = useMemo(() => [...data.myTickets, ...data.otherTickets].find((g) => g.ticket.key === ticketKey)?.ticket, [data, ticketKey]);
  const siblings = d ? data.diagrams.filter((x) => x.sessionId === d.sessionId && x.id !== d.id) : [];

  // Soft: the row stays, so the next scan of the agent's log does not add it again, and you can restore it.
  const setDeleted = async (deleted: boolean) => {
    if (deleted && !confirm(`Delete diagram ${id}? It goes off the board and the list. You can restore it from this page.`)) return;
    setBusy(true);
    try {
      setD(await api.editDiagram(id, { deleted }));
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
            made {ago(d.createdAt, now)}
          </span>
          {d.editedAt && (
            <span className="meta" title={stamp(d.editedAt)}>
              edited by you {ago(d.editedAt, now)}
            </span>
          )}
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
          {!d.deletedAt && !editing && (
            <>
              <button className="btn ghost small" onClick={() => setEditing(true)} title={d.source !== null ? "Fix the title or the source" : "Fix the title"}>
                Edit
              </button>
              <button className="btn ghost small" onClick={() => setDeleted(true)} disabled={busy} title="Take it off the board and the list">
                Delete
              </button>
            </>
          )}
        </div>
      </header>
      {d.deletedAt && (
        <div className="card diagram-deleted">
          <span>
            You deleted this diagram <span title={stamp(d.deletedAt)}>{ago(d.deletedAt, now)}</span>. It is not on the board or in the list.
          </span>
          <button className="btn small" onClick={() => setDeleted(false)} disabled={busy}>
            Restore
          </button>
        </div>
      )}
      {editing && (
        <DiagramEditor
          d={d}
          onDone={(saved) => {
            if (saved) setD(saved);
            setEditing(false);
          }}
        />
      )}
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
