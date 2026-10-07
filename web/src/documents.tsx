import { useEffect, useRef, useState } from "react";
import type { Run, TicketDocument } from "../../shared/types.ts";
import { age, api, elapsed, Markdown, stamp } from "./lib.tsx";
import { href } from "./routes.ts";

/** A ticket's markdown documents, and the agents that write them: the ticket summary, and the Documentation section. */

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
        {d.diagramId !== null && (
          <a className="meta" href={href(`d:${d.diagramId}`)} title="The diagram that this document was made from">
            diagram {d.diagramId}
          </a>
        )}
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
      </header>
      {prompting && !d.edit && <EditPrompt d={d} cwd={cwd} onDone={() => setPrompting(false)} onError={onError} />}
      {d.edit && <PendingEdit d={d} run={run} now={now} onError={onError} />}
      {open && d.hasBody && <DocumentBody d={d} />}
    </article>
  );
}

/** Opens a linked document (`#/doc:<id>`) once per link, and keeps the open state of the rest. */
function useOpened(anchor: string | null) {
  const [opened, setOpened] = useState<Record<number, boolean>>({});
  const linked = anchor?.startsWith("doc:") ? Number(anchor.slice(4)) : null;
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (linked !== null && seen.current !== linked) {
      seen.current = linked;
      setOpened((o) => ({ ...o, [linked]: true }));
    }
  }, [linked]);
  return [opened, setOpened] as const;
}

type DocsProps = {
  documents: TicketDocument[];
  /** The ticket's runs, to tell when an editing agent stopped. */
  runs: Run[];
  cwd: string;
  now: number;
  anchor: string | null;
  onError: (m: string | null) => void;
};

function runOf(d: TicketDocument, runs: Run[]): Run | undefined {
  return d.edit ? runs.find((r) => r.sessionId === d.edit!.sessionId) : undefined;
}

/** The button at the top of a ticket's workspace. It shows only while the ticket has no ticket summary. */
export function WriteTicketSummary({ ticket, cwd, onError }: { ticket: string; cwd: string; onError: (m: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const write = async () => {
    setBusy(true);
    onError(await api.writeTicketSummary(ticket, cwd));
    setBusy(false);
  };
  return (
    <button className="btn ghost" onClick={write} disabled={busy} title={`An agent in ${cwd} writes the start, middle and end states of ${ticket}, with user stories and diagrams`}>
      {busy ? "Starting…" : "Write a ticket summary"}
    </button>
  );
}

/** The ticket summary, under the Ticket section. It opens by itself. */
export function TicketSummaryDoc({ documents, runs, cwd, now, anchor, onError }: DocsProps) {
  const [opened, setOpened] = useOpened(anchor);
  const d = documents.find((x) => x.type === "ticket-summary");
  if (!d) return null;
  const open = opened[d.id] ?? true;
  return <DocumentCard d={d} run={runOf(d, runs)} open={open} onToggle={() => setOpened((o) => ({ ...o, [d.id]: !open }))} cwd={cwd} now={now} onError={onError} />;
}

/** The ticket's other documents. They stay short until you open one. */
export function Documentation({ documents, runs, cwd, now, anchor, onError }: DocsProps) {
  const [opened, setOpened] = useOpened(anchor);
  const docs = documents.filter((d) => d.type !== "ticket-summary");
  return (
    <div className="stack documentation">
      <h2 className="section-title">Documentation{docs.length ? ` · ${docs.length}` : ""}</h2>
      {docs.length === 0 ? (
        <p className="meta empty-note">No documents yet.</p>
      ) : (
        docs.map((d) => {
          const open = opened[d.id] ?? false;
          return <DocumentCard key={d.id} d={d} run={runOf(d, runs)} open={open} onToggle={() => setOpened((o) => ({ ...o, [d.id]: !open }))} cwd={cwd} now={now} onError={onError} />;
        })
      )}
    </div>
  );
}
