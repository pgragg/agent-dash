import { useEffect, useRef, useState } from "react";
import { defaultDueDate, isDate, type MoveTarget, moveTargets } from "../../shared/jiraVerbs.ts";
import type { Ticket, TicketDetail } from "../../shared/types.ts";
import { age, api, Markdown, plural, stamp } from "./lib.tsx";

/**
 * The ticket's description and newest comments, read from Jira when the section opens, and
 * verb buttons for one Jira change each. The server makes the change: no agent.
 */

const TTL_MS = 2 * 60_000;
const cache = new Map<string, { at: number; value: TicketDetail }>();

async function loadDetail(key: string, refresh: boolean): Promise<TicketDetail> {
  const hit = cache.get(key);
  if (hit && !refresh && Date.now() - hit.at < TTL_MS) return hit.value;
  const res = await fetch(`/api/ticket?key=${encodeURIComponent(key)}${refresh ? "&refresh" : ""}`, { headers: { "X-Agent-Dash": "1" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `could not read ${key} (${res.status})`);
  cache.set(key, { at: Date.now(), value: body });
  return body;
}

export function useTicketDetail(key: string, open: boolean) {
  const [detail, setDetail] = useState<TicketDetail | null>(() => cache.get(key)?.value ?? null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const forced = useRef(0);
  useEffect(() => {
    if (!open) return;
    let current = true;
    // Only the Reload click itself skips the caches, not each later open.
    loadDetail(key, nonce !== forced.current)
      .then((d) => {
        forced.current = nonce;
        if (!current) return;
        setDetail(d);
        setError(null);
      })
      .catch((err: Error) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [key, open, nonce]);
  return { detail, error, reload: () => setNonce((n) => n + 1) };
}

/** Moves the ticket in Jira. The click is Piper's approval of that one change. */
export function MoveButton({ ticket, target, from, onError, onMoved }: { ticket: string; target: MoveTarget; from: string; onError: (m: string | null) => void; onMoved: () => void }) {
  const [state, setState] = useState<"idle" | "moving" | "moved">("idle");
  const move = async () => {
    setState("moving");
    const err = await api.moveTicket(ticket, target.to, from);
    onError(err);
    setState(err ? "idle" : "moved");
    if (err) return;
    cache.delete(ticket);
    onMoved();
  };
  return (
    <button className="btn small" disabled={state !== "idle"} onClick={move} title={`Move ${ticket} from "${from}"${target.via ? ` through "${target.via}"` : ""} to "${target.to}" in Jira`}>
      {state === "moving" ? "Moving…" : state === "moved" ? `${target.to} ✓` : `Move to ${target.to}`}
    </button>
  );
}

/** "Set due date": the server sets it in Jira. The click is Piper's approval of that one change. */
export function DueDateVerb({ ticket, onError, onSet, compact = false }: { ticket: Ticket; onError: (m: string | null) => void; onSet?: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const [date, setDate] = useState(() => defaultDueDate(new Date()));
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  if (!open) {
    return (
      <button className="btn ghost small" onClick={() => setOpen(true)} title={`Set a new due date on ${ticket.key}`}>
        New due date…
      </button>
    );
  }
  const save = async () => {
    setState("saving");
    const err = await api.setDueDate(ticket.key, date, ticket.dueDate);
    onError(err);
    setState(err ? "idle" : "saved");
    if (err) return;
    cache.delete(ticket.key);
    onSet?.();
    setTimeout(() => setState("idle"), 4_000);
  };
  return (
    <span className="verb">
      <span className="meta">Set due date</span>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <button className="btn small" disabled={!isDate(date) || date === ticket.dueDate || state !== "idle"} onClick={save} title={`Set ${ticket.key} due ${date} in Jira`}>
        {state === "saving" ? "Saving…" : state === "saved" ? "Saved ✓" : "Set"}
      </button>
      {ticket.dueDate && <span className="meta">changes {ticket.dueDate}</span>}
      {compact && state === "idle" && (
        <button className="btn ghost small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      )}
    </span>
  );
}

function MoveVerb({ ticket, detail, onError, onMoved }: { ticket: Ticket; detail: TicketDetail; onError: (m: string | null) => void; onMoved: () => void }) {
  const [to, setTo] = useState("");
  const targets = moveTargets(detail.transitions, detail.status);
  const target = targets.find((x) => x.to === to);
  if (!targets.length) return <span className="meta">{detail.transitionsError ? `Could not read the transitions: ${detail.transitionsError}` : "No transitions from here."}</span>;
  return (
    <span className="verb">
      <span className="meta">Move to</span>
      <select value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">status…</option>
        {targets.map((x) => (
          <option key={x.to} value={x.to}>
            {x.to}
            {x.via ? ` (through ${x.via})` : ""}
          </option>
        ))}
      </select>
      {target && <MoveButton key={target.to} ticket={ticket.key} target={target} from={detail.status} onError={onError} onMoved={onMoved} />}
    </span>
  );
}

/** The "Ticket" section under the workspace header. `T` opens and closes it. */
export function TicketPanel({ ticket, onError }: { ticket: Ticket; onError: (m: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [whole, setWhole] = useState(false);
  const { detail, error, reload } = useTicketDetail(ticket.key, open);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== "t" || e.metaKey || e.ctrlKey || e.altKey || ["TEXTAREA", "INPUT", "SELECT"].includes(el.tagName)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const long = (detail?.description.length ?? 0) > 1200;
  const earlier = detail ? detail.commentTotal - detail.comments.length : 0;

  return (
    <section className={`card ticket-panel ${open ? "open" : ""}`}>
      <header className="card-head">
        <button className="ticket-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={`chev ${open ? "open" : ""}`}>›</span>
          <h3>Ticket</h3>
          <span className="meta">description{detail ? ` · ${plural(detail.commentTotal, "comment")}` : " and comments"}</span>
          <kbd>T</kbd>
        </button>
        <span className="grow" />
        {open && detail && <span className="meta">read {age(detail.fetchedAt, Date.now()) || "0s"} ago</span>}
        {open && (
          <button className="btn ghost small" onClick={reload}>
            Reload
          </button>
        )}
        <a className="btn ghost small" href={ticket.url} target="_blank" rel="noreferrer" title={ticket.file ? "Open the ticket file" : "Open in Jira"}>
          ↗
        </a>
      </header>
      {open && error && <p className="meta tone-text-bad">{error}</p>}
      {open && !detail && !error && <span className="shimmer" />}
      {open && detail && (
        <>
          <div className={`agent-message ${long && !whole ? "clamped" : ""}`}>
            {detail.description ? <Markdown text={detail.description} /> : <p className="meta">No description.</p>}
            {long && (
              <button className="btn ghost small expand" onClick={() => setWhole(!whole)}>
                {whole ? "Show less" : "Show the whole description"}
              </button>
            )}
          </div>
          {detail.comments.length > 0 && (
            <ol className="ticket-comments">
              {earlier > 0 && (
                <li className="meta">
                  <a href={ticket.url} target="_blank" rel="noreferrer">
                    {plural(earlier, "earlier comment")} in Jira ↗
                  </a>
                </li>
              )}
              {detail.comments.map((c, i) => (
                <li key={i}>
                  <div className="note-meta">
                    <span>{c.author}</span>
                    <span title={c.created}>· {stamp(c.created)}</span>
                  </div>
                  <Markdown text={c.body} />
                </li>
              ))}
            </ol>
          )}
          {ticket.file ? (
            <p className="meta">A local ticket: {ticket.file}. Move the file to another status folder to change its status.</p>
          ) : (
            <>
              <div className="verbs">
                <MoveVerb ticket={ticket} detail={detail} onError={onError} onMoved={reload} />
                <DueDateVerb ticket={{ ...ticket, dueDate: detail.dueDate }} onError={onError} onSet={reload} />
              </div>
              <p className="meta">Both change Jira at once. A move can give a ticket with no due date the default one, two weeks out.</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
