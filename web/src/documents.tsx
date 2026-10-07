import { useEffect, useMemo, useRef, useState } from "react";
import type { Dashboard, Run, TicketDocument } from "../../shared/types.ts";
import { age, api, elapsed, Markdown, plural, stamp } from "./lib.tsx";
import { href } from "./routes.ts";

/** Documents: a ticket's Documentation section, a document's page, and the list of every document. */

/** A body changes only with a save, so each version loads once. */
const bodies = new Map<string, Promise<string>>();
function bodyOf(d: TicketDocument): Promise<string> {
  const key = `${d.id} ${d.updatedAt}`;
  let p = bodies.get(key);
  if (!p) {
    p = api.document(d.id).then((x) => x.body);
    p.catch(() => bodies.delete(key));
    bodies.set(key, p);
  }
  return p;
}

function DocumentBody({ d }: { d: TicketDocument }) {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    bodyOf(d).then(setBody, (err: Error) => setError(err.message));
  }, [d.id, d.updatedAt]);
  if (error) return <p className="error">{error}</p>;
  if (body === null) return <span className="shimmer wide" />;
  return (
    <div className="doc-body">
      <Markdown text={body} />
    </div>
  );
}

/** The prompt box under a document's head: what the agent should change. */
function EditPrompt({ d, cwd, onDone, onError }: { d: TicketDocument; cwd: string; onDone: () => void; onError: (m: string | null) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const err = await api.editDocument(d.id, text, cwd);
    setBusy(false);
    onError(err);
    if (!err) onDone();
  };
  return (
    <div className="composer doc-prompt">
      <textarea
        autoFocus
        rows={3}
        value={text}
        placeholder="What should the agent change? For example: add a sequence diagram of the deploy, or shorten the user stories."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape" && (!text.trim() || confirm("Throw away your prompt?"))) onDone();
        }}
      />
      <div className="composer-bar">
        <span className="meta">An agent in {cwd} rewrites this document and saves it with the same id.</span>
        <div className="composer-actions">
          <button className="btn ghost small" onClick={onDone} disabled={busy}>
            Cancel
          </button>
          <button className="btn small" onClick={send} disabled={busy || !text.trim()}>
            {busy ? "Starting…" : "Ask the agent"} <kbd>⌘↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

/** An agent edit that has not saved: who does it, and a way out when its agent stopped. */
function PendingEdit({ d, run, now, onError }: { d: TicketDocument; run: Run | undefined; now: number; onError: (m: string | null) => void }) {
  const edit = d.edit!;
  // A headless agent waits for a reply when its turn ends, so a run that is not working stopped. A new run gets time to start.
  const stopped = !!run && run.status !== "working" && now - Date.parse(edit.startedAt) > 30_000;
  const what = d.hasBody ? <>An agent edits this document: “{edit.prompt.length > 160 ? `${edit.prompt.slice(0, 159)}…` : edit.prompt}”</> : <>An agent writes this {d.type === "ticket-summary" ? "ticket summary" : "document"}.</>;
  return (
    <div className={`doc-pending ${stopped ? "tone-text-warn" : ""}`}>
      <span className={`dot ${stopped ? "tone-warn" : "tone-working pulse"}`} />
      <span className="grow">
        {stopped ? <>The agent stopped without a save{run.status === "awaiting_input" ? ": it can wait on you" : ""}. </> : null}
        {what} <a href={href(`c:${edit.sessionId}`)}>Open the conversation</a>
        <span className="meta"> · {stopped ? `started ${age(edit.startedAt, now)} ago` : elapsed(edit.startedAt, now)}</span>
      </span>
      <button
        className="btn ghost small"
        title={d.hasBody ? "Stop waiting for this edit. The agent can still save." : "Remove this empty document, so you can write it again"}
        onClick={async () => {
          if (stopped || confirm("Stop waiting for this agent? If it still saves, its version replaces this one.")) onError(await api.cancelDocumentEdit(d.id));
        }}
      >
        {d.hasBody ? "Stop waiting" : "Remove"}
      </button>
    </div>
  );
}

/** Every run on the board, to find the agent of an edit or the folder of a document's conversation. */
const allRuns = (data: Dashboard): Run[] => [...data.myTickets, ...data.otherTickets].flatMap((g) => g.runs).concat(data.unlinkedRuns);

function DocumentCard({ d, run, open, onToggle, cwd, now, onError }: { d: TicketDocument; run: Run | undefined; open: boolean; onToggle: () => void; cwd: string; now: number; onError: (m: string | null) => void }) {
  const [prompting, setPrompting] = useState(false);
  return (
    <article className={`card doc ${open ? "open" : ""}`} id={`doc:${d.id}`}>
      <header className="card-head doc-head">
        <button className="doc-toggle" onClick={onToggle} aria-expanded={open} title={d.title}>
          <span className="caret">{open ? "▾" : "▸"}</span>
          <h3>{d.title}</h3>
        </button>
        {d.type === "ticket-summary" && <span className="tag tone-good">ticket summary</span>}
        {d.sessionId && d.sessionId !== d.edit?.sessionId && (
          <a className="meta" href={href(`c:${d.sessionId}`)} title="The conversation that made it">
            conversation
          </a>
        )}
        <span className="grow" />
        <span className="meta" title={`Saved ${stamp(d.updatedAt)}`}>
          {age(d.updatedAt, now)}
        </span>
        {d.hasBody && !d.edit && (
          <button className="btn ghost small" onClick={() => setPrompting(!prompting)} aria-expanded={prompting} title="Ask an agent to change this document">
            Edit
          </button>
        )}
        <a className="btn ghost small" href={href(`doc:${d.id}`)} title="Open the document's page">
          ↗
        </a>
      </header>
      {prompting && !d.edit && <EditPrompt d={d} cwd={cwd} onDone={() => setPrompting(false)} onError={onError} />}
      {d.edit && <PendingEdit d={d} run={run} now={now} onError={onError} />}
      {open && d.hasBody && <DocumentBody d={d} />}
    </article>
  );
}

/** The documents of a ticket, or of a conversation with no ticket. Only a ticket gets a ticket summary. */
export function Documentation({ ticket, documents, runs, cwd, now, onError }: {
  ticket: string | null;
  documents: TicketDocument[];
  /** The runs that can edit these documents, to tell when an editing agent stopped. */
  runs: Run[];
  cwd: string;
  now: number;
  onError: (m: string | null) => void;
}) {
  // A ticket summary opens by itself; the rest stay short until you open one.
  const [opened, setOpened] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  if (!ticket && !documents.length) return null;
  const write = async () => {
    if (!ticket) return;
    setBusy(true);
    onError(await api.writeTicketSummary(ticket, cwd));
    setBusy(false);
  };
  return (
    <div className="stack documentation">
      <div className="section-head">
        <h2 className="section-title">Documentation{documents.length ? ` · ${documents.length}` : ""}</h2>
        <span className="grow" />
        {ticket && !documents.some((d) => d.type === "ticket-summary") && (
          <button className="btn small" onClick={write} disabled={busy} title={`An agent in ${cwd} writes the start, middle and end states of ${ticket}, with user stories and diagrams`}>
            {busy ? "Starting…" : "Write a ticket summary"}
          </button>
        )}
      </div>
      {documents.length === 0 ? (
        <p className="meta empty-note">No documents yet. A ticket summary is a good first one.</p>
      ) : (
        documents.map((d) => {
          const open = opened[d.id] ?? d.type === "ticket-summary";
          return <DocumentCard key={d.id} d={d} run={d.edit ? runs.find((r) => r.sessionId === d.edit!.sessionId) : undefined} open={open} onToggle={() => setOpened((o) => ({ ...o, [d.id]: !open }))} cwd={cwd} now={now} onError={onError} />;
        })
      )}
    </div>
  );
}

/** `#/doc:ID`: one document, also one with no ticket. `diagramId` opens the document of an older diagram link. */
export function DocumentView({ id, diagramId, data, now }: { id?: number; diagramId?: number; data: Dashboard; now: number }) {
  const d = data.documents.find((x) => (diagramId === undefined ? x.id === id : x.diagramId === diagramId));
  const [prompting, setPrompting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runs = useMemo(() => allRuns(data), [data]);
  if (!d) return <article className="workspace"><div className="zero big">{diagramId === undefined ? `Document ${id} is gone.` : `Diagram ${diagramId} has no document: it was deleted.`}</div></article>;
  const ticket = [...data.myTickets, ...data.otherTickets].find((g) => g.ticket.key === d.ticket)?.ticket;
  const made = d.sessionId ? runs.find((r) => r.sessionId === d.sessionId) : undefined;
  const remove = async () => {
    if (!confirm(`Delete document ${d.id}, "${d.title}"? You cannot undo this.`)) return;
    const err = await api.deleteDocument(d.id);
    if (err) setError(err);
    else location.hash = d.ticket ? href(`t:${d.ticket}`) : "#/documents";
  };
  return (
    <article className="workspace">
      <header className="ws-head">
        <div className="eyebrow">
          <span>Document {d.id}</span>
          {d.type === "ticket-summary" && <span className="tag tone-good">ticket summary</span>}
        </div>
        <h1>{d.title}</h1>
        <div className="ws-meta doc-links">
          {d.ticket ? (
            <a className="key-link" href={href(`t:${d.ticket}`)} title="Open the ticket on the board">
              {d.ticket}
            </a>
          ) : (
            <span className="meta">no ticket</span>
          )}
          {ticket && <span className="meta">{ticket.summary}</span>}
          {d.sessionId && (
            <>
              <span className="sep">·</span>
              <a href={href(`c:${d.sessionId}`)} title="Open the conversation that made it">
                {made ? (made.name ?? made.firstPrompt).slice(0, 80) : `conversation ${d.sessionId.slice(-6)}`}
              </a>
            </>
          )}
          <span className="sep">·</span>
          <span className="meta" title={stamp(d.createdAt)}>
            made {age(d.createdAt, now)} ago
          </span>
          {d.updatedAt !== d.createdAt && (
            <span className="meta" title={stamp(d.updatedAt)}>
              saved {age(d.updatedAt, now)} ago
            </span>
          )}
          <span className="grow" />
          {d.hasBody && !d.edit && (
            <button className="btn ghost small" onClick={() => setPrompting(!prompting)} aria-expanded={prompting} title="Ask an agent to change this document">
              Edit
            </button>
          )}
          <button className="btn ghost small" onClick={remove} title="Delete this document">
            Delete
          </button>
        </div>
      </header>
      {error && <div className="toast" role="alert">{error}</div>}
      {prompting && !d.edit && <EditPrompt d={d} cwd={made?.cwd ?? "~"} onDone={() => setPrompting(false)} onError={setError} />}
      {d.edit && <PendingEdit d={d} run={runs.find((r) => r.sessionId === d.edit!.sessionId)} now={now} onError={setError} />}
      {d.hasBody && (
        <section className="card doc-page-body">
          <DocumentBody d={d} />
        </section>
      )}
    </article>
  );
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

function DocumentPreview({ d }: { d: TicketDocument }) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  return <div ref={ref} className="doc-preview">{visible && d.hasBody ? <DocumentBody d={d} /> : null}</div>;
}

/** `#/documents`: every document, newest change first. */
export function DocumentsView({ data, now }: { data: Dashboard; now: number }) {
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = data.documents.filter((d) => words.every((w) => `${d.title} ${d.ticket ?? ""} ${d.type}`.toLowerCase().includes(w)));
  return (
    <article className="workspace">
      <header className="ws-head">
        <h1>Documents</h1>
        <div className="ws-meta">
          <span className="meta">{plural(data.documents.length, "document")} · ticket summaries first, then the newest change</span>
        </div>
        <input className="search" type="search" placeholder="Search titles, tickets, types" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>
      {found.length === 0 ? (
        <div className="zero big">{query ? "No document matches." : "No documents yet. Write a ticket summary from a ticket, or let an agent draw a diagram: each diagram becomes a document."}</div>
      ) : (
        <div className="doc-grid">
          {found.map((d) => (
            <article key={d.id} className="doc-card">
              <a className="doc-card-preview" href={href(`doc:${d.id}`)} aria-label={`Open document ${d.id}: ${d.title}`}>
                <DocumentPreview d={d} />
              </a>
              <div className="doc-card-meta">
                <a className="doc-card-title" href={href(`doc:${d.id}`)} title={d.title}>
                  {d.title}
                </a>
                <div className="doc-card-tags">
                  {d.type === "ticket-summary" && <span className="tag tone-good">ticket summary</span>}
                  {d.ticket && (
                    <a className="key-link" href={href(`t:${d.ticket}`)} title="Open the ticket on the board">
                      {d.ticket}
                    </a>
                  )}
                  {d.edit && <span className="tag tone-working">agent at work</span>}
                  <span className="grow" />
                  <span className="meta" title={stamp(d.updatedAt)}>
                    {age(d.updatedAt, now)}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </article>
  );
}
