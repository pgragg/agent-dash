import { useState } from "react";
import type { Dashboard, ParkedRun, ParkReason, Ticket } from "../../shared/types.ts";
import { conversationHash } from "./agents.tsx";
import { age, inline, plural, post, stamp } from "./lib.tsx";
import { href } from "./routes.ts";

/** The waiting agents that agent-dash stopped, grouped by ticket, with what each one needed. */

const REASON: Record<ParkReason, string> = {
  ticket_done: "ticket is Done",
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

/** Open tickets first, then no ticket, then Done tickets; each group newest park first. */
export function parkedGroups(data: Pick<Dashboard, "parked" | "myTickets" | "otherTickets">): Group[] {
  const tickets = new Map([...data.myTickets, ...data.otherTickets].map((g) => [g.ticket.key, g.ticket]));
  const groups = new Map<string, Group>();
  for (const p of data.parked) {
    const id = p.ticket ?? "";
    const g = groups.get(id) ?? { key: p.ticket, ticket: p.ticket ? tickets.get(p.ticket) : undefined, rows: [] };
    g.rows.push(p);
    groups.set(id, g);
  }
  const rank = (g: Group) => (!g.key ? 1 : g.ticket?.statusCategory === "done" ? 2 : 0);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.rows[0].parkedAt.localeCompare(a.rows[0].parkedAt));
}

function ParkedRow({ p, now, onError }: { p: ParkedRun; now: number; onError: (m: string | null) => void }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = p.needs ?? p.lastMessage.slice(-300);
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

export function ParkedView({ data, now }: { data: Dashboard; now: number }) {
  const [error, setError] = useState<string | null>(null);
  const groups = parkedGroups(data);
  const dismissAll = async (rows: ParkedRun[]) => {
    for (const p of rows) {
      const err = await post(`/api/parked/dismiss?session=${encodeURIComponent(p.sessionId)}`);
      if (err) return setError(err);
    }
    setError(null);
  };
  return (
    <article className="workspace">
      <header className="ws-head">
        <h1>{data.parked.length ? `${plural(data.parked.length, "parked agent")}` : "No parked agents"}</h1>
        <div className="ws-meta">
          <span className="meta">At most 15 agents wait for you. agent-dash stops the others and keeps what each one needed. Reply or Resume continues the same session.</span>
        </div>
      </header>
      {error && <pre className="error">{error}</pre>}
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
            {g.ticket?.statusCategory === "done" && <span className="tone-text-good">Done in Jira</span>}
            <span className="meta">{plural(g.rows.length, "agent")}</span>
            <span className="grow" />
            <button className="btn small ghost" onClick={() => dismissAll(g.rows)} title="Dismiss every parked agent in this group">
              Dismiss all
            </button>
          </header>
          <ol className="actions">
            {g.rows.map((p) => (
              <ParkedRow key={p.sessionId} p={p} now={now} onError={setError} />
            ))}
          </ol>
        </section>
      ))}
    </article>
  );
}
