import { useState } from "react";
import { type Dashboard, PARKED_ASK_CHARS, type ParkedRun, type ParkReason, type Ticket } from "../../shared/types.ts";
import { conversationHash } from "./agents.tsx";
import { age, inline, plural, post, stamp } from "./lib.tsx";
import { ViewToolsSlot } from "./resizeView.tsx";
import { href } from "./routes.ts";

/** The parked asks on the board: a ticket's why list, and the Parked asks pane. Each has Send, Resume and Dismiss. */

const REASON: Record<ParkReason, string> = {
  ticket_done: "ticket Done",
  resolved: "thread resolved",
  needs_nothing: "needs nothing",
  superseded: "a newer agent took over",
  stale: "waited over 24 h",
  over_cap: "over the cap of 15",
};

interface Group {
  key: string | null;
  ticket: Ticket | undefined;
  rows: ParkedRun[];
}

function ParkedRow({ p, now, onError }: { p: ParkedRun; now: number; onError: (m: string | null) => void }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = p.needs ?? p.lastMessage.slice(-PARKED_ASK_CHARS);
  const resume = async (message?: string) => {
    setBusy(true);
    const err = await post(`/api/conversations/resume?session=${encodeURIComponent(p.sessionId)}`, message ? { message } : undefined);
    setBusy(false);
    onError(err);
    if (!err) location.hash = conversationHash(p.sessionId);
  };
  return (
    <li className="action parked" id={`parked:${p.sessionId}`}>
      <div className="action-body">
        <div className="action-summary">
          <a href={conversationHash(p.sessionId)} title="Read the conversation">
            <b>{p.name ?? p.sessionId}</b>
          </a>{" "}
          · <span className="meta">{REASON[p.reason]}</span>
        </div>
        <div className="need-gist">
          <b>Needs:</b> {inline(ask)}
        </div>
        {p.latest && <div className="meta">{inline(p.latest)}</div>}
        <div className="composer parked-reply">
          <textarea
            value={reply}
            placeholder="Reply. The agent starts again with your answer."
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && reply.trim()) void resume(reply.trim());
            }}
          />
        </div>
      </div>
      <span className="meta action-age" title={stamp(p.parkedAt)}>
        parked {age(p.parkedAt, now)} ago
      </span>
      <button className="btn small primary" disabled={busy || !reply.trim()} onClick={() => resume(reply.trim())} title="Resume the agent with this reply (⌘↵)">
        Send
      </button>
      <button className="btn small" disabled={busy} onClick={() => resume()} title="Continue this session on its page, with no reply yet">
        {busy ? "Resuming…" : "Resume"}
      </button>
      <button className="btn small ghost" disabled={busy} onClick={async () => onError(await post(`/api/parked/dismiss?session=${encodeURIComponent(p.sessionId)}`))} title="You do not need this ask any more. The conversation stays in History.">
        Dismiss
      </button>
    </li>
  );
}

/** A ticket's parked asks inside its "why" list, with the same Send, Resume and Dismiss as the Parked asks pane. */
export function ParkedAskList({ rows, now, onError }: { rows: ParkedRun[]; now: number; onError: (m: string | null) => void }) {
  return (
    <ol className="actions why-parked">
      {rows.map((p) => (
        <ParkedRow key={p.sessionId} p={p} now={now} onError={onError} />
      ))}
    </ol>
  );
}

/** One group of the board's Parked asks: a ticket's asks, or the asks with no ticket (`ticketKey` null). */
export function ParkedAsksPane({ ticketKey, rows, data, onBoard, now }: { ticketKey: string | null; rows: ParkedRun[]; data: Dashboard; onBoard: boolean; now: number }) {
  const [error, setError] = useState<string | null>(null);
  const ticket = ticketKey ? [...data.myTickets, ...data.otherTickets].find((g) => g.ticket.key === ticketKey)?.ticket : undefined;
  const dismissAll = async (list: ParkedRun[]) => {
    for (const p of list) {
      const err = await post(`/api/parked/dismiss?session=${encodeURIComponent(p.sessionId)}`);
      if (err) return setError(err);
    }
    setError(null);
  };
  return (
    <article className="workspace">
      <header className="ws-head">
        <div className="eyebrow">
          <span className="tone-text-waiting">Parked asks</span>
        </div>
        <h1>{ticket?.summary ?? ticketKey ?? "Conversations with no ticket"}</h1>
        <div className="ws-meta">
          {ticketKey && onBoard && (
            <a className="key-link" href={href(`t:${ticketKey}`)} title="Open the ticket on the board">
              {ticketKey}
            </a>
          )}
          <span className="meta">
            {rows.length ? `${plural(rows.length, "agent")} parked, each with its own ask. Send or Resume continues the same session, and Dismiss removes the ask.` : "No parked ask here any more."}
          </span>
          <span className="grow" />
          <ViewToolsSlot />
        </div>
      </header>
      {error && <pre className="error">{error}</pre>}
      {rows.length > 0 && <ParkedGroups groups={[{ key: ticketKey, ticket, rows }]} now={now} onError={setError} dismissAll={dismissAll} />}
    </article>
  );
}

function ParkedGroups({ groups, now, onError, dismissAll }: { groups: Group[]; now: number; onError: (m: string | null) => void; dismissAll: (rows: ParkedRun[]) => Promise<void> }) {
  return (
    <>
      {groups.map((g) => (
        <section key={g.key ?? "none"} className="card flush parked-group">
          <header className="card-head parked-head">
            {g.key ? (
              <a className="key-link" href={href(`t:${g.key}`)}>
                {g.key}
              </a>
            ) : (
              <span className="meta">no ticket</span>
            )}
            <h3>{g.ticket?.summary ?? (g.key ? "" : "Conversations with no ticket")}</h3>
            {g.ticket?.statusCategory === "done" && <span className="tone-text-good">Done in {g.ticket.source.label}</span>}
            <span className="meta">{plural(g.rows.length, "agent")}</span>
            <span className="grow" />
            <button className="btn small ghost" onClick={() => dismissAll(g.rows)} title="Dismiss every parked agent in this group">
              Dismiss all
            </button>
          </header>
          <ol className="actions">
            {g.rows.map((p) => (
              <ParkedRow key={p.sessionId} p={p} now={now} onError={onError} />
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}
