import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitSummary } from "../../shared/nextSteps.ts";
import { prRef } from "../../shared/refs.ts";
import type { Action, ActionKind, AttentionItem, AttentionKind, Dashboard, HistoryRun, NextStep, Note, PullRequest, Run, ThreadStatusChange, TicketGroup, TicketSummary, TicketSummaryState, Turn } from "../../shared/types.ts";
import { conversationHash, launchAgent, ResumeHere, resuming } from "./agents.tsx";
import { filterHistory, groupByDay } from "./history.ts";
import { PrPanel, PrVerbButton } from "./prPanel.tsx";
import { ciTag } from "./prView.ts";
import { countPrs, groupOpenPrs } from "./prs.ts";
import { age, api, dirLabel, dueLabel, elapsed, inline, Markdown, type NotifyState, plural, prName, resumeCommand, runTitle, shortDate, stamp, useDashboard, useFlash, useNow, useWaitNotifications } from "./lib.tsx";
import { Composer, LivePanel } from "./liveControl.tsx";
import { needStep } from "./needs.ts";
import { href, humanAge, parseHash, resolveBoardRef, type Route } from "./routes.ts";
import { FixLogin } from "./fixLogin.tsx";
import { rowKey } from "./rowNav.ts";
import { SdlcBar, Smoketests } from "./sdlc.tsx";
import { SlackQuotes } from "./slackQuotes.tsx";
import { DueDateVerb, TicketPanel } from "./ticketPanel.tsx";
import { DiagramCards, DiagramsView, DiagramView } from "./diagrams.tsx";
import { SessionScope } from "./mermaid.tsx";
import { type BoardMode, kanbanColumns, stageOf, useBoardMode } from "./kanban.ts";
import { DEFAULT_SNOOZE, isSnoozed, SNOOZE_OPTIONS, type SnoozeOption, snoozeUntil, untilLabel } from "./snooze.ts";

/**
 * agent-dash answers one question: "what do I work on next?".
 *
 * The left rail is a queue: one entry per ticket (or per ticket-less run or PR), ranked by
 * its most urgent signal. The right side is a workspace for the selected entry, with
 * everything needed to act on it in place: the drafted next steps, the agent's full last
 * message with a reply box, the PRs, and the run history. "Done for now" clears an entry
 * until something about it changes, so the queue works like an inbox.
 */

// ---- subjects: the things you can select --------------------------------------------

interface Subject {
  id: string;
  ticket: TicketGroup | null;
  /** A run with no ticket. */
  run: Run | null;
  /** A PR with no ticket and no run. */
  prUrl: string | null;
  /** Most urgent first. */
  items: AttentionItem[];
  /** Changes whenever a signal changes, so "done for now" expires on news. */
  fingerprint: string;
}

const KIND: Record<AttentionKind, { title: string; tone: "waiting" | "working" | "bad" | "warn" | "good" | "muted" }> = {
  run_error: { title: "Agent hit an error", tone: "bad" },
  awaiting_input: { title: "Agent is waiting on you", tone: "waiting" },
  changes_requested: { title: "Changes requested", tone: "bad" },
  ci_failing: { title: "CI is failing", tone: "bad" },
  merge_conflict: { title: "Merge conflict", tone: "bad" },
  ready_to_merge: { title: "Ready to merge", tone: "good" },
  in_review: { title: "PR out for review", tone: "working" },
  overdue: { title: "Overdue", tone: "bad" },
  due_soon: { title: "Due soon", tone: "warn" },
  stalled: { title: "Stalled", tone: "muted" },
};

const SHORT: Record<AttentionKind, string> = {
  run_error: "error",
  awaiting_input: "waiting",
  changes_requested: "changes",
  ci_failing: "CI red",
  merge_conflict: "conflict",
  ready_to_merge: "merge",
  in_review: "in review",
  overdue: "overdue",
  due_soon: "due soon",
  stalled: "stalled",
};

function buildSubjects(d: Dashboard): Map<string, Subject> {
  const out = new Map<string, Subject>();
  const add = (id: string, init: Omit<Subject, "id" | "items" | "fingerprint">) => {
    if (!out.has(id)) out.set(id, { id, items: [], fingerprint: "", ...init });
    return out.get(id)!;
  };
  for (const g of [...d.myTickets, ...d.otherTickets]) add(`t:${g.ticket.key}`, { ticket: g, run: null, prUrl: null });
  for (const r of d.unlinkedRuns) add(`r:${r.sessionId}`, { ticket: null, run: r, prUrl: null });
  for (const a of d.attention) {
    const id = a.ticketKey ? `t:${a.ticketKey}` : a.sessionId ? `r:${a.sessionId}` : `p:${a.prUrl}`;
    const s = out.get(id) ?? add(id, { ticket: null, run: a.run ?? null, prUrl: a.prUrl ?? null });
    s.items.push(a);
  }
  for (const s of out.values()) s.fingerprint = s.items.map((a) => `${a.kind}@${a.updatedAt}`).join("|");
  return out;
}

/** The ticket is Done in Jira. */
function isDone(s: Subject): boolean {
  return s.ticket?.ticket.statusCategory === "done";
}

/** Something here needs you, not only someone else. */
function actionable(s: Subject): boolean {
  return s.items.some((a) => !a.info);
}

/** The item that leads: the most urgent one that needs you, else the first. */
function lead(s: Subject): AttentionItem | undefined {
  return s.items.find((a) => !a.info) ?? s.items[0];
}

/** The other kinds of signal on the subject, for tags next to the lead. */
function otherKinds(s: Subject): AttentionKind[] {
  const top = lead(s)?.kind;
  return [...new Set(s.items.map((a) => a.kind))].filter((k) => k !== top);
}

function subjectTitle(s: Subject): string {
  if (s.ticket) return s.ticket.ticket.summary;
  if (s.run) return runTitle(s.run);
  return s.prUrl ? prName(s.prUrl) : s.id;
}

/** Live agents first (waiting before working), then the newest. */
/** You marked this thread as no longer relevant to the subject's ticket. */
function isResolved(s: Subject, run: Run): boolean {
  return s.ticket?.threads[run.sessionId]?.status === "resolved";
}

/** The ticket's threads that still matter: everything you have not marked resolved. */
function relevantRuns(s: Subject): Run[] {
  return s.ticket ? s.ticket.runs.filter((r) => !isResolved(s, r)) : s.run ? [s.run] : [];
}

function liveRuns(s: Subject): Run[] {
  const runs = relevantRuns(s);
  const rank = (r: Run) => (r.status === "awaiting_input" ? 0 : r.status === "working" ? 1 : 2);
  return runs.filter((r) => r.status !== "finished").sort((a, b) => rank(a) - rank(b) || b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/** The run that "open in iTerm" and the reply box act on. */
function primaryRun(s: Subject): Run | undefined {
  return s.items.find((a) => a.run?.status === "awaiting_input")?.run ?? liveRuns(s)[0] ?? s.items.find((a) => a.run)?.run;
}

// ---- "done for now" -----------------------------------------------------------------

const DONE_FOR_NOW_KEY = "agent-dash:done-for-now";

function useDoneForNow() {
  const [map, setMap] = useState<Record<string, string>>(() => JSON.parse(localStorage.getItem(DONE_FOR_NOW_KEY) ?? "{}"));
  const save = (next: Record<string, string>) => {
    setMap(next);
    localStorage.setItem(DONE_FOR_NOW_KEY, JSON.stringify(next));
  };
  return {
    isDone: (s: Subject) => map[s.id] === s.fingerprint,
    markDone: (s: Subject) => save({ ...map, [s.id]: s.fingerprint }),
    wake: (s: Subject) => {
      const { [s.id]: _gone, ...rest } = map;
      save(rest);
    },
  };
}

// ---- small pieces -------------------------------------------------------------------

function Dot({ tone, pulse }: { tone: string; pulse?: boolean }) {
  return <span className={`dot tone-${tone} ${pulse ? "pulse" : ""}`} aria-hidden />;
}

function Kbd({ children }: { children: string }) {
  return <kbd>{children}</kbd>;
}

function CopyButton({ text, label, className = "btn ghost" }: { text: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={className}
      title={text}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

function OpenTab({ run, onError, className = "btn ghost", label = "Open in iTerm", hotkey = false }: { run: HistoryRun; onError: (m: string | null) => void; className?: string; label?: string; hotkey?: boolean }) {
  if (run.headless) {
    return (
      <a className={className} href={`#/c:${encodeURIComponent(run.sessionId)}`} title="Open this conversation's page">
        Open {hotkey && <Kbd>O</Kbd>}
      </a>
    );
  }
  if (!run.itermSessionId) {
    const copy = <CopyButton text={resumeCommand(run)} label="Copy resume" className={className} />;
    // Only a run with a status file is known to be closed; another one may still be open in a terminal.
    return run.status === "finished" && run.statusSource === "extension" ? <><ResumeHere run={run} onError={onError} small={className.includes("small")} />{copy}</> : copy;
  }
  return (
    <button className={className} title="Bring this session's iTerm tab to the front" onClick={async () => onError(await api.focusTab(run.sessionId))}>
      {label} {hotkey && <Kbd>O</Kbd>}
    </button>
  );
}

function statusText(run: HistoryRun, now: number): string {
  const guess = run.statusSource === "heuristic" ? " (guess)" : "";
  if (run.status === "awaiting_input") return `waiting ${age(run.statusSince, now)}${guess}`;
  if (run.status === "working") return `working ${age(run.statusSince, now)}${guess}`;
  return `finished ${age(run.lastActivityAt, now)} ago`;
}

function runTone(run: HistoryRun): string {
  return run.endedInError ? "bad" : run.status === "awaiting_input" ? "waiting" : run.status === "working" ? "working" : "muted";
}

// ---- queue (left rail) --------------------------------------------------------------

function QueueItem({ s, selected, onSelect, now, summary, rank, notes = 0, snoozedUntil, card = false, dim = false }: { s: Subject; selected: boolean; onSelect: () => void; now: number; summary?: TicketSummaryState; rank?: number; notes?: number; snoozedUntil?: string; card?: boolean; dim?: boolean }) {
  const top = lead(s);
  const run = primaryRun(s);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const done = isDone(s);
  const headline = top ? KIND[top.kind].title : run ? statusText(run, now) : s.ticket?.ticket.status ?? "";
  // On a Done ticket nothing is urgent, so the headline goes quiet and the green tag says why.
  const tone = done ? "muted" : top ? KIND[top.kind].tone : run ? runTone(run) : "muted";
  const when = top?.kind === "awaiting_input" && run ? age(run.statusSince, now) : age(top?.updatedAt ?? run?.lastActivityAt ?? s.ticket?.ticket.updatedAt, now);
  const extra = otherKinds(s);
  return (
    <button ref={ref} className={`q-item ${card ? "k-card" : ""} ${dim ? "dim" : ""} ${selected ? "selected" : ""}`} onClick={onSelect} aria-current={selected}>
      <span className="q-rank">{rank ?? ""}</span>
      <span className="q-body">
        <span className="q-head">
          <Dot tone={tone} pulse={run?.status === "working"} />
          <span className={`q-headline tone-text-${tone}`}>{headline}</span>
          <span className="q-when">{when}</span>
        </span>
        <span className="q-title">{subjectTitle(s)}</span>
        <span className="q-tags">
          {s.ticket && <span className="q-key">{s.ticket.ticket.key}</span>}
          {done && <span className="tag tone-good">done</span>}
          {extra.map((k) => (
            <span key={k} className={`tag tone-${KIND[k].tone}`}>
              {SHORT[k]}
            </span>
          ))}
          {summary && !done && <span className="tag tone-muted" title="Next steps drafted">✦ next steps</span>}
          {notes > 0 && <span className="tag tone-muted" title={`${plural(notes, "note")}`}>✎ {notes}</span>}
          {snoozedUntil && <span className="tag tone-muted" title={new Date(snoozedUntil).toLocaleString()}>until {untilLabel(snoozedUntil, now)}</span>}
        </span>
      </span>
    </button>
  );
}

function RailSection({ title, count, children, defaultOpen = true, hint }: { title: string; count: number; children: React.ReactNode; defaultOpen?: boolean; hint?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;
  return (
    <section className="rail-section">
      <button className="rail-title" onClick={() => setOpen(!open)} title={hint}>
        <span className={`chev ${open ? "open" : ""}`}>›</span>
        {title}
        <span className="count">{count}</span>
      </button>
      {open && <div className="rail-list">{children}</div>}
    </section>
  );
}

function BoardModeToggle({ mode, setMode }: { mode: BoardMode; setMode: (m: BoardMode) => void }) {
  const option = (m: BoardMode, label: string, title: string) => (
    <button role="radio" aria-checked={mode === m} className={`btn small ${mode === m ? "" : "ghost"}`} onClick={() => setMode(m)} title={`${title} (V)`}>
      {label}
    </button>
  );
  return (
    <span className="seg" role="radiogroup" aria-label="Board layout">
      {option("queue", "Queue", "The queue, with a workspace for the selected entry")}
      {option("kanban", "Kanban", "One column per SDLC stage")}
    </span>
  );
}

/** The board's entries as cards, in the column of the SDLC stage that each ticket reached. */
function KanbanBoard({ order, dim, ranks, selected, onSelect, data, now, until }: { order: Subject[]; dim: Set<Subject>; ranks: Map<Subject, number>; selected: Subject | null; onSelect: (s: Subject) => void; data: Dashboard; now: number; until: (s: Subject) => string | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  // The selected card scrolls into view at load, which would hide the first stages. This runs after the cards' effects.
  useEffect(() => {
    if (ref.current) ref.current.scrollLeft = 0;
  }, []);
  const columns = kanbanColumns(order, (s) => (s.ticket ? stageOf(s.ticket, data.sdlcEvents[s.ticket.ticket.key] ?? []) : null));
  return (
    <div className="kanban" ref={ref}>
      {columns.map((c) => (
        <section key={c.id} className={`k-col ${c.items.length ? "" : "empty"}`} aria-label={c.label}>
          <h2 className="rail-title k-col-head">
            {c.label}
            <span className="count">{c.items.length}</span>
          </h2>
          <div className="k-col-list">
            {c.items.map((s) => (
              <QueueItem
                key={s.id}
                s={s}
                card
                dim={dim.has(s)}
                rank={ranks.get(s)}
                selected={s.id === selected?.id}
                onSelect={() => onSelect(s)}
                now={now}
                summary={s.ticket ? data.summaries[s.ticket.ticket.key] : undefined}
                notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0}
                snoozedUntil={isSnoozed(until(s), now) ? until(s) : undefined}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---- workspace (right side) ---------------------------------------------------------

const STALE_MS = 30 * 60_000;

/** One drafted step, with a button that starts a pi agent on it, with the same context as "Start a new agent". */
function StepRow({ ticket, step, cwd, onError }: { ticket: string; step: NextStep; cwd: string; onError: (m: string | null) => void }) {
  const [state, setState] = useState<"idle" | "starting" | "started">("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const start = async (terminal: boolean) => {
    setState("starting");
    try {
      setSessionId(await launchAgent(ticket, { step: step.id, cwd, terminal }));
      onError(null);
      setState("started");
    } catch (err) {
      onError((err as Error).message);
      setState("idle");
    }
  };
  return (
    <li className="step" id={`step:${step.id}`}>
      <span className="step-body">{inline(step.body)}</span>
      {sessionId ? <a className="btn ghost small" href={conversationHash(sessionId)}>Started ✓ Open</a> : <button className="btn ghost small" onClick={(e) => start(e.altKey)} disabled={state !== "idle" || !cwd.trim()} title={`Start a pi agent in ${cwd} on this step, with this page as context. ⌥-click opens it in a new iTerm tab.`}>
        {state === "starting" ? "Starting…" : state === "started" ? "Started ✓" : "Start agent"}
      </button>}
    </li>
  );
}

function SummaryBody({ ticket, summary, cwd, onError }: { ticket: string; summary: TicketSummary; cwd: string; onError: (m: string | null) => void }) {
  if (!summary.steps.length) return <Markdown text={summary.summary ?? ""} />;
  const parts = splitSummary(summary.summary ?? "");
  return (
    <>
      <Markdown text={parts.before} />
      <ol className="steps">
        {summary.steps.map((st) => (
          <StepRow key={st.id} ticket={ticket} step={st} cwd={cwd} onError={onError} />
        ))}
      </ol>
      {parts.after && <Markdown text={parts.after} />}
    </>
  );
}

function NextSteps({ s, state, notes, now, cwd, onError }: { s: Subject; state: TicketSummaryState | undefined; notes: Note[]; now: number; cwd: string; onError: (m: string | null) => void }) {
  const key = s.ticket!.ticket.key;
  const [starting, setStarting] = useState(false);
  const ask = async (force: boolean) => {
    setStarting(true);
    onError(await api.summarize(key, force));
    setStarting(false);
  };
  const latest = state?.latest;
  const shown = latest?.status === "done" ? latest : (state?.lastDone ?? null);
  const running = latest?.status === "in_progress";
  const stuck = running && now - Date.parse(latest!.requestedAt) > STALE_MS;
  // Activity after the summary was written makes it out of date.
  const lastActivity = [...relevantRuns(s).map((r) => r.lastActivityAt), ...(s.ticket?.prs.map((p) => p.updatedAt) ?? []), ...notes.map((n) => n.createdAt)].sort().at(-1);
  const outdated = shown?.generatedAt && lastActivity && Date.parse(lastActivity) - Date.parse(shown.generatedAt) > 60_000;

  return (
    <section className="card next-steps">
      <header className="card-head">
        <h3>
          <span className="spark">✦</span> Next steps
        </h3>
        {outdated && !running && <span className="tag tone-warn">out of date</span>}
        <span className="grow" />
        {shown?.generatedAt && <span className="meta">drafted {age(shown.generatedAt, now)} ago</span>}
        {shown && !running && (
          <button className="btn ghost small" onClick={() => ask(false)} disabled={starting}>
            Redraft <Kbd>S</Kbd>
          </button>
        )}
      </header>
      {running && (
        <div className={`drafting ${stuck ? "stuck" : ""}`}>
          {stuck ? (
            <>
              <span>Drafting has run for {elapsed(latest!.requestedAt, now)}. It is probably stuck.</span>
              <button className="btn small" onClick={() => ask(true)}>
                Start again
              </button>
            </>
          ) : (
            <>
              <span className="shimmer" />
              <span>
                Reading Jira, PRs, Slack and agent history… <b>{elapsed(latest!.requestedAt, now)}</b>
              </span>
            </>
          )}
        </div>
      )}
      {latest?.status === "failed" && (
        <div className="draft-failed" title={latest.error ?? ""}>
          The last draft failed: {(latest.error ?? "").split("\n")[0].slice(0, 160)}{" "}
          <button className="btn small" onClick={() => ask(true)}>
            Retry
          </button>
        </div>
      )}
      {shown?.summary ? (
        <>
          <SummaryBody ticket={key} summary={shown} cwd={cwd} onError={onError} />
          <SlackQuotes summaryId={shown.id} text={shown.summary} />
        </>
      ) : (
        !running && (
          <div className="empty-draft">
            <p>Let an agent read the ticket, its PRs, Slack and the agent history, and draft what to do next.</p>
            <button className="btn primary" onClick={() => ask(false)} disabled={starting}>
              {starting ? "Starting…" : "Draft next steps"} <Kbd>S</Kbd>
            </button>
          </div>
        )
      )}
    </section>
  );
}

function Notes({ ticket, notes, now, onError, focusSignal }: { ticket: string; notes: Note[]; now: number; onError: (m: string | null) => void; focusSignal: number }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusSignal) ref.current?.focus();
  }, [focusSignal]);
  const add = async () => {
    if (!text.trim()) return;
    setSaving(true);
    const err = await api.addNote(ticket, text);
    setSaving(false);
    onError(err);
    if (!err) setText("");
  };
  return (
    <section className="card notes">
      <header className="card-head">
        <h3>Notes</h3>
        <span className="meta">private · next-steps drafts read them</span>
      </header>
      {notes.length > 0 && (
        <ol className="note-list">
          {[...notes].reverse().map((n) => (
            <li key={n.id} id={`note:${n.id}`}>
              <div className="note-meta">
                <span title={n.createdAt}>{stamp(n.createdAt)}</span>
                <span>· {age(n.createdAt, now)} ago</span>
                <button
                  className="btn ghost small note-delete"
                  onClick={async () => {
                    if (confirm("Delete this note?")) onError(await api.deleteNote(n.id));
                  }}
                >
                  Delete
                </button>
              </div>
              <Markdown text={n.body} />
            </li>
          ))}
        </ol>
      )}
      <div className="composer note-composer">
        <textarea
          ref={ref}
          rows={2}
          value={text}
          placeholder="Add a note: a decision, a hunch, what you are waiting for…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              add();
            }
            if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
          }}
        />
        <div className="composer-bar">
          <span className="meta">saved on {ticket} with the time</span>
          <button className="btn" onClick={add} disabled={saving || !text.trim()}>
            {saving ? "Saving…" : "Add note"} <Kbd>⌘↵</Kbd>
          </button>
        </div>
      </div>
    </section>
  );
}

/** Folders the ticket's agents worked in, newest first, then the home folder. */
function workFolders(s: Subject): string[] {
  const runs = [...relevantRuns(s)].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  // Home paths show as ~ (the server expands it), so the same folder is not offered twice.
  return [...new Set([...runs.map((r) => r.cwd.replace(/^\/Users\/[^/]+/, "~")).filter(Boolean), "~"])];
}

function StartAgent({ s, cwd, setCwd, onError, focusSignal }: { s: Subject; cwd: string; setCwd: (cwd: string) => void; onError: (m: string | null) => void; focusSignal: number }) {
  const key = s.ticket!.ticket.key;
  const folders = workFolders(s);
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<{ at: number; sessionId: string | null } | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [context, setContext] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusSignal) ref.current?.focus();
  }, [focusSignal]);
  const start = async () => {
    if (!message.trim()) return;
    setStarting(true);
    try {
      const sessionId = await launchAgent(key, { message, cwd, terminal });
      onError(null);
      setMessage("");
      setStarted({ at: Date.now(), sessionId });
    } catch (err) {
      onError((err as Error).message);
    }
    setStarting(false);
  };
  return (
    <section className="card start-agent">
      <header className="card-head">
        <h3>Start a new agent</h3>
        <span className="meta">starts pi with this page as context; you talk to it here</span>
      </header>
      <div className="composer">
        <textarea
          ref={ref}
          rows={3}
          value={message}
          placeholder={`First message for the new agent on ${key}…`}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              start();
            }
            if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
          }}
        />
        <div className="composer-bar">
          <label className="folder">
            <span className="meta">in</span>
            <input list={`folders-${key}`} value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
            <datalist id={`folders-${key}`}>
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </label>
          <label className="meta" title="Open pi in a new iTerm tab instead of on this page">
            <input type="checkbox" checked={terminal} onChange={(e) => setTerminal(e.target.checked)} /> in iTerm
          </label>
          <button className="btn primary" onClick={start} disabled={starting || !message.trim() || !cwd.trim()}>
            {starting ? "Starting…" : "Start agent"} <Kbd>⌘↵</Kbd>
          </button>
        </div>
      </div>
      {started && Date.now() - started.at < 30_000 && (
        <p className="meta started">
          {started.sessionId ? <>Started. It shows under Agents once pi saves the first message, or <a href={conversationHash(started.sessionId)}>open its page</a>.</> : "Started in a new iTerm tab. It shows under Agents once it is running."}
        </p>
      )}
      <details
        className="context-preview"
        onToggle={async (e) => {
          if ((e.target as HTMLDetailsElement).open) setContext(await api.agentContext(key));
        }}
      >
        <summary>What the agent gets: notes, next steps, PRs, the latest message from each relevant agent, and the run history</summary>
        {context === null ? <span className="shimmer" /> : <pre>{context}</pre>}
      </details>
    </section>
  );
}

/**
 * "Resolve" keeps the thread on the ticket but stops it counting. "Unlink" takes it off the
 * ticket, for a thread that only named the key.
 */
function ThreadButtons({ ticket, run, onError, className = "btn ghost" }: { ticket: string; run: Run; onError: (m: string | null) => void; className?: string }) {
  const [saving, setSaving] = useState(false);
  const set = async (status: "resolved" | "unlinked") => {
    setSaving(true);
    onError(await api.setThread(ticket, run.sessionId, status));
    setSaving(false);
  };
  return (
    <>
      <button className={className} onClick={() => set("resolved")} disabled={saving} title={`This thread no longer matters to ${ticket}`}>
        Resolve
      </button>
      <button className={className} onClick={() => set("unlinked")} disabled={saving} title={`This thread has nothing to do with ${ticket}: take it off the ticket`}>
        Unlink
      </button>
    </>
  );
}

function AgentCard({ run, now, onError, focusSignal, primary, ticket }: { run: Run; now: number; onError: (m: string | null) => void; focusSignal: number; primary: boolean; ticket?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [chat, setChat] = useState(false);
  const long = run.lastMessage.length > 900;
  return (
    <section className={`card agent tone-border-${runTone(run)}`} id={`r:${run.sessionId}`}>
      <header className="card-head">
        <Dot tone={runTone(run)} pulse={run.status === "working"} />
        <div className="agent-title">
          <h3 title={run.firstPrompt}>{runTitle(run)}</h3>
          <span className="meta">
            {statusText(run, now)} · {dirLabel(run.cwd)} · {plural(run.userMessageCount, "prompt")}
          </span>
        </div>
        <span className="grow" />
        {ticket && <ThreadButtons ticket={ticket} run={run} onError={onError} />}
        <OpenTab run={run} onError={onError} hotkey={primary} />
      </header>
      <LivePanel run={run} now={now} onError={onError} />
      {/* The whole chat ends with the last message, so it replaces it. */}
      {/* A working agent writes its log on every tool call; reload on a new prompt or when it stops, not on each write. */}
      {chat && <Chat sessionId={run.sessionId} refreshKey={run.status === "working" ? run.userMessageCount : run.lastActivityAt + run.status} />}
      {!chat && run.lastMessage && (
        <div className={`agent-message ${long && !expanded ? "clamped" : ""}`}>
          <SessionScope sessionId={run.sessionId}>
            <Markdown text={run.lastMessage} />
          </SessionScope>
          {long && (
            <button className="btn ghost small expand" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Show the whole message"}
            </button>
          )}
        </div>
      )}
      <button className="btn ghost small chat-toggle" aria-expanded={chat} onClick={() => setChat(!chat)}>{chat ? "Show only the last message" : "Show the conversation"}</button>
      {run.status !== "finished" && <Composer run={run} onError={onError} focusSignal={primary ? focusSignal : 0} />}
    </section>
  );
}

function PrRow({ pr, now }: { pr: PullRequest; now: number }) {
  const open = pr.state === "open";
  const review = pr.reviewDecision === "APPROVED" ? ["approved", "good"] : pr.reviewDecision === "CHANGES_REQUESTED" ? ["changes requested", "bad"] : pr.reviewDecision === "REVIEW_REQUIRED" ? ["needs review", "muted"] : null;
  const ci = open ? ciTag(pr) : null;
  return (
    <div className="pr-line">
      <a className={`pr-row ${open ? "" : "closed"}`} href={href(prRef(pr.url) ?? "prs")} title="Open the PR panel">
        <span className={`pr-state state-${pr.isDraft && open ? "draft" : pr.state}`}>{pr.isDraft && open ? "draft" : pr.state}</span>
        <span className="pr-name">{prName(pr.url)}</span>
        <span className="pr-title">{pr.title}</span>
        {ci && <span className={`tag tone-${ci.tone}`} title={ci.title}>{ci.text}</span>}
        {open && review && <span className={`tag tone-${review[1]}`}>{review[0]}</span>}
        {open && pr.mergeable === "CONFLICTING" && <span className="tag tone-bad">conflict</span>}
        <span className="meta">{age(pr.updatedAt, now)}</span>
      </a>
      <a className="ext-link pr-ext" href={pr.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label="Open on GitHub">
        ↗
      </a>
    </div>
  );
}

function History({ runs: allRuns, now, onError, ticket, threads = {}, focus = null }: { runs: Run[]; now: number; onError: (m: string | null) => void; ticket?: string; threads?: Record<string, ThreadStatusChange>; focus?: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const runs = allRuns.filter((r) => threads[r.sessionId]?.status !== "resolved");
  const resolved = allRuns.filter((r) => threads[r.sessionId]?.status === "resolved");
  // A link to one run opens its row, and shows the older runs or the resolved ones when it is there.
  useEffect(() => {
    const id = focus?.startsWith("r:") ? focus.slice(2) : null;
    if (!id || !allRuns.some((r) => r.sessionId === id)) return;
    setOpen(id);
    if (runs.slice(0, -6).some((r) => r.sessionId === id)) setAll(true);
    if (resolved.some((r) => r.sessionId === id)) setShowResolved(true);
  }, [focus]);
  const shown = all ? runs : runs.slice(-6);
  return (
    <ol className="history">
      {runs.length > shown.length && (
        <li>
          <button className="btn ghost small" onClick={() => setAll(true)}>
            Show {plural(runs.length - shown.length, "older run")}
          </button>
        </li>
      )}
      {shown.map((r) => (
        <li key={r.sessionId} id={`h:r:${r.sessionId}`} className={open === r.sessionId ? "open" : ""}>
          <div className="h-row">
            <Dot tone={runTone(r)} pulse={r.status === "working"} />
            <button className="h-title" onClick={() => setOpen(open === r.sessionId ? null : r.sessionId)} title={r.firstPrompt}>
              {runTitle(r)}
            </button>
            <span className="meta">
              {shortDate(r.startedAt)} · {dirLabel(r.cwd)} · {plural(r.userMessageCount, "prompt")}
              {r.createdPrs.length > 0 && ` · opened ${plural(r.createdPrs.length, "PR")}`}
            </span>
            <span className="grow" />
            <span className="meta">{statusText(r, now)}</span>
            {ticket && <ThreadButtons ticket={ticket} run={r} onError={onError} className="btn ghost small" />}
            <OpenTab run={r} onError={onError} className="btn ghost small" label="Open" />
          </div>
          {open === r.sessionId && r.lastMessage && (
            <div className="h-message">
              <SessionScope sessionId={r.sessionId}>
                <Markdown text={r.lastMessage} />
              </SessionScope>
            </div>
          )}
        </li>
      ))}
      {ticket && resolved.length > 0 && (
        <li className="resolved-group">
          <button className="btn ghost small" onClick={() => setShowResolved(!showResolved)}>
            <span className={`chev ${showResolved ? "open" : ""}`}>›</span> Resolved · {resolved.length}
          </button>
        </li>
      )}
      {ticket &&
        showResolved &&
        resolved.map((r) => {
          const t = threads[r.sessionId];
          return (
            <li key={r.sessionId} id={`h:r:${r.sessionId}`} className="resolved">
              <div className="h-row">
                <span className="resolved-mark" aria-hidden>
                  ✓
                </span>
                <span className="h-title" title={r.firstPrompt}>
                  {runTitle(r)}
                </span>
                <span className="meta" title={t.createdAt}>
                  resolved {age(t.createdAt, now)} ago{t.reason ? ` · ${t.reason}` : ""}
                </span>
                <span className="grow" />
                <button className="btn ghost small" onClick={async () => onError(await api.setThread(ticket, r.sessionId, "relevant"))} title={`Count this thread for ${ticket} again`}>
                  Mark relevant
                </button>
              </div>
            </li>
          );
        })}
    </ol>
  );
}

/** Hides the ticket from the board until a time. `Z` snoozes with the picked option. */
function SnoozeControl({ ticket, until, now, signal, onSnoozed, onError }: { ticket: string; until: string | undefined; now: number; signal: number; onSnoozed: () => void; onError: (m: string | null) => void }) {
  const [option, setOption] = useState<SnoozeOption>(DEFAULT_SNOOZE);
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const snoozed = isSnoozed(until, now);
  const at = snoozeUntil(option, new Date(now), date);
  const save = async (next: Date | null) => {
    setBusy(true);
    const err = await api.snooze(ticket, next?.toISOString() ?? null);
    setBusy(false);
    onError(err);
    if (!err && next) onSnoozed();
  };
  // The control mounts again for each entry, so only a press after the mount counts.
  const seen = useRef(signal);
  useEffect(() => {
    if (signal === seen.current) return;
    seen.current = signal;
    if (!snoozed && at && !busy) save(at);
  }, [signal]);

  if (snoozed) {
    return (
      <span className="verb">
        <span className="meta" title={new Date(until!).toLocaleString()}>Snoozed until {untilLabel(until!, now)}</span>
        <button className="btn ghost" onClick={() => save(null)} disabled={busy}>
          Unsnooze
        </button>
      </span>
    );
  }
  return (
    <span className="verb">
      <button className="btn" onClick={() => at && save(at)} disabled={!at || busy} title={at ? `Hide from the board until ${at.toLocaleString()}` : "Pick a date in the future"}>
        Snooze <Kbd>Z</Kbd>
      </button>
      <select value={option} onChange={(e) => setOption(e.target.value as SnoozeOption)} aria-label="Snooze for">
        {SNOOZE_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {option === "date" && <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Snooze until" />}
    </span>
  );
}

function Workspace({ s, data, now, position, doneForNow, onDoneForNow, onWake, onSnoozed, focusSignal, noteSignal, agentSignal, snoozeSignal, anchor }: {
  s: Subject;
  data: Dashboard;
  now: number;
  position: string | null;
  doneForNow: boolean;
  onDoneForNow: () => void;
  onWake: () => void;
  /** After a snooze saves, so the board can move on. */
  onSnoozed: () => void;
  snoozeSignal: number;
  focusSignal: number;
  noteSignal: number;
  agentSignal: number;
  /** The run, step, or note in this entry that the URL points at. */
  anchor: string | null;
}) {
  useFlash(anchor);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [s.id]);
  // Shared by "Start a new agent" and the next steps' buttons, so both start in the same folder.
  const [cwd, setCwd] = useState(() => workFolders(s)[0]);
  useEffect(() => setCwd(workFolders(s)[0]), [s.id]);
  const t = s.ticket?.ticket;
  const due = t && t.statusCategory !== "done" ? dueLabel(t.dueDate) : null;
  const live = liveRuns(s);
  const primary = primaryRun(s);
  // A ticket with no live agent still shows its latest run, so you can read where it stopped.
  const relevant = relevantRuns(s);
  const featured = live.length ? live : primary && !isResolved(s, primary) ? [primary] : relevant.length ? [relevant.at(-1)!] : [];
  const prs = s.ticket?.prs ?? [];
  const runs = s.ticket?.runs ?? (s.run ? [s.run] : []);
  // A ticket's diagrams, or a run's when the entry is a run with no ticket.
  const diagrams = data.diagrams.filter((d) => (s.ticket ? d.ticket === s.ticket.ticket.key : d.sessionId === s.run?.sessionId));
  const top = lead(s);

  return (
    <article className="workspace" key={s.id}>
      <header className="ws-head">
        <div className="eyebrow">
          {isDone(s) && (
            <>
              <Dot tone="good" />
              <span className="tone-text-good">Done in Jira</span>
            </>
          )}
          {top && isDone(s) ? (
            <span className={`tag tone-${KIND[top.kind].tone}`}>{SHORT[top.kind]}</span>
          ) : top ? (
            <>
              <Dot tone={KIND[top.kind].tone} />
              <span className={`tone-text-${KIND[top.kind].tone}`}>{KIND[top.kind].title}</span>
              {otherKinds(s).map((k) => (
                <span key={k} className={`tag tone-${KIND[k].tone}`}>
                  {SHORT[k]}
                </span>
              ))}
            </>
          ) : isDone(s) ? null : (
            <span>{live.length ? "Agents at work" : "Quiet"}</span>
          )}
          {position && <span className="meta">· {position}</span>}
        </div>
        <h1>{subjectTitle(s)}</h1>
        <div className="ws-meta">
          {t && (
            <a className="key-link" href={t.url} target="_blank" rel="noreferrer" title="Open in Jira">
              {t.key} ↗
            </a>
          )}
          {t && <span className={`pill cat-${t.statusCategory}`}>{t.status}</span>}
          {t?.priority && <span className="meta">{t.priority}</span>}
          {due && <span className={`tone-text-${due.tone}`}>{due.text}</span>}
          {s.prUrl && !t && (
            <>
              <a className="key-link" href={href(prRef(s.prUrl) ?? "prs")} title="Open the PR panel">
                {prName(s.prUrl)}
              </a>
              <a className="ext-link" href={s.prUrl} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label="Open on GitHub">
                ↗
              </a>
            </>
          )}
          <span className="grow" />
          {t && <SnoozeControl key={t.key} ticket={t.key} until={data.snoozedUntil[t.key]} now={now} signal={snoozeSignal} onSnoozed={onSnoozed} onError={setError} />}
          {actionable(s) &&
            (doneForNow ? (
              <button className="btn ghost" onClick={onWake}>
                Back to the queue
              </button>
            ) : (
              <button className="btn" onClick={onDoneForNow} title="Hide until something about it changes">
                Done for now <Kbd>E</Kbd>
              </button>
            ))}
        </div>
        {s.ticket && <SdlcBar group={s.ticket} events={data.sdlcEvents[s.ticket.ticket.key] ?? []} cwd={cwd} onError={setError} />}
        {s.items.length > 0 && (
          <ul className="why">
            {s.items.map((a, i) => (
              // A stable key: the verb button keeps its "Started" state when the list changes order.
              <li key={`${a.kind}:${a.prUrl ?? a.sessionId ?? a.ticketKey ?? i}`}>
                <Dot tone={KIND[a.kind].tone} />
                <span>{a.reason}</span>
                <PrVerbButton item={a} data={data} />
                {t && (a.kind === "overdue" || a.kind === "due_soon") && <DueDateVerb ticket={t} onError={setError} compact />}
              </li>
            ))}
          </ul>
        )}
      </header>

      {t && <TicketPanel key={t.key} ticket={t} cwd={cwd} onError={setError} />}

      {error && (
        <div className="toast" role="alert">
          {error}
          <button className="btn ghost small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {s.ticket && <NextSteps s={s} state={data.summaries[s.ticket.ticket.key]} notes={data.notes[s.ticket.ticket.key] ?? []} now={now} cwd={cwd} onError={setError} />}

      {s.ticket && <Smoketests ticket={s.ticket.ticket.key} events={data.sdlcEvents[s.ticket.ticket.key] ?? []} now={now} cwd={cwd} onError={setError} />}

      {s.ticket && <StartAgent key={s.id} s={s} cwd={cwd} setCwd={setCwd} onError={setError} focusSignal={agentSignal} />}

      {s.ticket && <Notes ticket={s.ticket.ticket.key} notes={data.notes[s.ticket.ticket.key] ?? []} now={now} onError={setError} focusSignal={noteSignal} />}

      {featured.length > 0 && (
        <div className="stack">
          <h2 className="section-title">{live.length ? (live.length === 1 ? "Agent" : `Agents · ${live.length}`) : "Last run"}</h2>
          {featured.map((r) => (
            <AgentCard key={r.sessionId} run={r} now={now} onError={setError} focusSignal={focusSignal} primary={r.sessionId === primary?.sessionId} ticket={s.ticket?.ticket.key} />
          ))}
        </div>
      )}

      {prs.length > 0 && (
        <div className="stack">
          <h2 className="section-title">Pull requests · {prs.length}</h2>
          <div className="card flush">
            {[...prs]
              .sort((a, b) => Number(b.state === "open") - Number(a.state === "open") || b.updatedAt.localeCompare(a.updatedAt))
              .map((p) => (
                <PrRow key={p.url} pr={p} now={now} />
              ))}
          </div>
        </div>
      )}

      {diagrams.length > 0 && (
        <div className="stack">
          <h2 className="section-title">Diagrams · {diagrams.length}</h2>
          <DiagramCards diagrams={diagrams} now={now} showConversation />
        </div>
      )}

      {runs.length > 0 && (
        <div className="stack">
          <h2 className="section-title">History · {plural(runs.length, "run")}</h2>
          <div className="card flush">
            <History runs={runs} now={now} onError={setError} ticket={s.ticket?.ticket.key} threads={s.ticket?.threads} focus={anchor} />
          </div>
        </div>
      )}

      {s.ticket && runs.length === 0 && prs.length === 0 && <p className="meta empty-note">No agent has worked on this ticket yet.</p>}
    </article>
  );
}

// ---- PRs view -----------------------------------------------------------------------

function PrsView({ data, now }: { data: Dashboard; now: number }) {
  const groups = useMemo(() => groupOpenPrs(data), [data]);
  const total = countPrs(groups);
  const ticketCount = groups.filter((g) => g.ticket).length;
  return (
    <article className="workspace">
      <header className="ws-head">
        <h1>Open pull requests</h1>
        <div className="ws-meta">
          <span className="meta">
            {plural(total, "open PR")} · {plural(ticketCount, "ticket")} · most urgent first
          </span>
        </div>
      </header>
      {groups.length === 0 && <div className="zero big">You have no open PRs.</div>}
      {groups.map((g) => {
        const t = g.ticket;
        const due = t && t.statusCategory !== "done" ? dueLabel(t.dueDate) : null;
        return (
          <div className="stack" key={t?.key ?? "none"}>
            <header className="pr-group-head">
              {t ? (
                <>
                  <a className="key-link" href={t.url} target="_blank" rel="noreferrer" title="Open in Jira">
                    {t.key} ↗
                  </a>
                  <a className="pr-group-title" href={href(`t:${t.key}`)} title="Open on the board">
                    {t.summary}
                  </a>
                  <span className={`pill cat-${t.statusCategory}`}>{t.status}</span>
                  {due && <span className={`tone-text-${due.tone}`}>{due.text}</span>}
                </>
              ) : (
                <span className="pr-group-title">No ticket</span>
              )}
              <span className="grow" />
              <span className="meta">{plural(g.prs.length, "PR")}</span>
            </header>
            <div className="card flush">
              {g.prs.map(({ pr, items }) => {
                const todo = items.filter((a) => !a.info);
                return (
                  <div key={pr.url} className="pr-entry" id={prRef(pr.url) ?? undefined}>
                    <PrRow pr={pr} now={now} />
                    {todo.length > 0 && (
                      <ul className="pr-why">
                        {todo.map((a) => (
                          <li key={a.kind}>
                            <Dot tone={KIND[a.kind].tone} />
                            <span>{a.reason}</span>
                            <PrVerbButton item={a} data={data} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </article>
  );
}

// ---- Actions view -----------------------------------------------------------------

const ACTION_KIND: Record<ActionKind, { short: string; tone: string }> = {
  ...(Object.fromEntries(Object.entries(KIND).map(([k, v]) => [k, { short: SHORT[k as AttentionKind], tone: v.tone }])) as Record<AttentionKind, { short: string; tone: string }>),
  next_step: { short: "next step", tone: "muted" },
};

/** What the action's button opens, in words. */
function targetLabel(target: string): string {
  if (target.startsWith("pr:")) return prName(`https://github.com/${target.slice(3).replace(/\/(\d+)$/, "/pull/$1")}`);
  if (target.startsWith("r:")) return "Open agent";
  if (target.startsWith("step:")) return "Open step";
  return "Open on board";
}

function ActionRow({ a, now }: { a: Action; now: number }) {
  const kind = ACTION_KIND[a.kind];
  return (
    <li className="action" id={`a:${a.id}`}>
      <Dot tone={kind.tone} />
      <div className="action-body">
        <div className="action-summary">{inline(a.summary)}</div>
        <div className="action-meta">
          <span className={`tag tone-${kind.tone}`}>{kind.short}</span>
          {a.ticketKey ? (
            <a className="key-link" href={href(`t:${a.ticketKey}`)} title="Open the ticket on the board">
              {a.ticketKey}
            </a>
          ) : (
            <span className="meta">no ticket</span>
          )}
          {a.ticketSummary && <span className="meta action-ticket">{a.ticketSummary}</span>}
        </div>
      </div>
      <a className="meta action-age" href={href(`a:${a.id}`)} title={`On this list since ${stamp(a.createdAt)} · link to this action`}>
        {humanAge(a.createdAt, now) === "just now" ? "added just now" : `added ${humanAge(a.createdAt, now)} ago`}
      </a>
      <a className="btn small" href={href(a.target)}>
        {targetLabel(a.target)} →
      </a>
    </li>
  );
}

function ActionsView({ data, now, focus }: { data: Dashboard; now: number; focus: string | null }) {
  useFlash(focus);
  const actions = data.actions;
  const steps = actions.filter((a) => a.kind === "next_step").length;
  return (
    <article className="workspace">
      <header className="ws-head">
        <h1>Next actions</h1>
        <div className="ws-meta">
          <span className="meta">
            {plural(actions.length - steps, "signal")} from the queue · {plural(steps, "drafted next step")} · first to do first
          </span>
        </div>
      </header>
      {focus && !actions.some((a) => `a:${a.id}` === focus) && <div className="toast">Action {focus.slice(2)} is done or gone: its signal cleared, or its ticket was redrafted.</div>}
      {actions.length === 0 ? (
        <div className="zero big">Nothing to do. Draft next steps on a ticket to get its recommended actions here.</div>
      ) : (
        <div className="card flush">
          <ol className="actions">
            {actions.map((a) => (
              <ActionRow key={a.id} a={a} now={now} />
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}

// ---- Needs you view ---------------------------------------------------------------

/** The first step of the ticket's newest finished next-steps draft. */
function firstStep(data: Dashboard, s: Subject): NextStep | null {
  const state = s.ticket ? data.summaries[s.ticket.ticket.key] : undefined;
  const shown = state?.latest.status === "done" ? state.latest : state?.lastDone;
  return shown?.steps[0] ?? null;
}

/** The entries behind "N things need you", in queue order: what each is, its ticket, and where to act in agent-dash. */
function NeedsView({ queue, hidden, data, now }: { queue: Subject[]; hidden: number; data: Dashboard; now: number }) {
  return (
    <article className="workspace">
      <header className="ws-head">
        <h1>{queue.length ? `${plural(queue.length, "thing")} need you` : "Nothing needs you"}</h1>
        <div className="ws-meta">
          <span className="meta">
            Most urgent first, as in the queue{hidden > 0 && ` · ${hidden} done for now, not shown`}
          </span>
        </div>
      </header>
      {queue.length === 0 ? (
        <div className="zero big">Nothing needs you. The agents at work and the PRs out for review are on the board.</div>
      ) : (
        <div className="card flush">
          <ol className="actions">
            {queue.map((s, i) => {
              const item = lead(s)!;
              const step = firstStep(data, s);
              const next = needStep(item, step, s.id);
              const tone = KIND[item.kind].tone;
              return (
                <li key={s.id} className="action need" id={`need:${s.id}`}>
                  <span className="q-rank">{i + 1}</span>
                  <Dot tone={tone} />
                  <div className="action-body">
                    <div className="action-summary">
                      <b className={`tone-text-${tone}`}>{KIND[item.kind].title}</b> · {inline(item.reason)}
                    </div>
                    <div className="action-meta">
                      {s.ticket ? (
                        <a className="key-link" href={href(`t:${s.ticket.ticket.key}`)} title="Open the ticket on the board">
                          {s.ticket.ticket.key}
                        </a>
                      ) : (
                        <span className="meta">no ticket</span>
                      )}
                      <span className="meta action-ticket">{subjectTitle(s)}</span>
                      {otherKinds(s).map((k) => (
                        <span key={k} className={`tag tone-${KIND[k].tone}`}>
                          {SHORT[k]}
                        </span>
                      ))}
                    </div>
                    {step && next.ref !== `step:${step.id}` && (
                      <div className="action-meta need-step">
                        <span className="meta">Drafted next step:</span>
                        <a href={href(`step:${step.id}`)} className="need-step-body">
                          {inline(step.body)}
                        </a>
                      </div>
                    )}
                  </div>
                  <span className="meta action-age" title={stamp(item.updatedAt)}>
                    {age(item.updatedAt, now)} ago
                  </span>
                  <PrVerbButton item={item} data={data} />
                  <a className="btn small primary" href={href(next.ref)}>
                    {next.label} →
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </article>
  );
}

// ---- History view -------------------------------------------------------------------

/** Rows rendered at first. A year of chats is about a thousand rows, which is slow to render at once. */
const HISTORY_PAGE = 150;
/** Turns shown when a chat opens. The newest are kept, because that is where the chat stopped. */
const TURNS_SHOWN = 40;

/** Loads again whenever the key changes, which the page passes as the dashboard's last update. */
function useLoad<T>(load: () => Promise<T>, key: unknown): { value: T | null; error: string | null } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    load()
      .then((v) => {
        if (!current) return;
        setValue(v);
        setError(null);
      })
      .catch((err: Error) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [key]);
  return { value, error };
}

function Chat({ sessionId, refreshKey }: { sessionId: string; refreshKey: unknown }) {
  const { value, error } = useLoad(() => api.transcript(sessionId), `${sessionId} ${refreshKey}`);
  const [all, setAll] = useState(false);
  if (error && !value) return <p className="meta chat-note">{error}</p>;
  if (!value) return <p className="meta chat-note">Loading the chat…</p>;
  const turns: Turn[] = value.turns;
  const shown = all ? turns : turns.slice(-TURNS_SHOWN);
  return (
    <SessionScope sessionId={sessionId}>
      <div className="chat">
        {turns.length > shown.length && (
          <button className="btn ghost small" onClick={() => setAll(true)}>
            Show {plural(turns.length - shown.length, "earlier message")}
          </button>
        )}
        {shown.length === 0 && <p className="meta">This chat has no text yet.</p>}
        {shown.map((t, i) => (
          <div key={turns.length - shown.length + i} className={`turn ${t.role}`}>
            <div className="turn-head">
              <b>{t.role === "user" ? "You" : "Agent"}</b>
              {t.at && <span className="meta">{stamp(t.at)}</span>}
            </div>
            <Markdown text={t.text} />
          </div>
        ))}
      </div>
    </SessionScope>
  );
}

function HistoryView({ data, now }: { data: Dashboard; now: number }) {
  const { value: runs, error } = useLoad(api.history, data.generatedAt);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const tickets = useMemo(() => new Map([...data.myTickets, ...data.otherTickets].map((g) => [g.ticket.key, g.ticket])), [data]);
  const found = useMemo(() => filterHistory(runs ?? [], query), [runs, query]);
  const groups = groupByDay(found.slice(0, limit), now);
  const live = (runs ?? []).filter((r) => r.status !== "finished").length;

  return (
    <article className="workspace">
      <header className="ws-head">
        <h1>Chat history</h1>
        <div className="ws-meta">
          <span className="meta">{runs ? `${plural(runs.length, "chat")} · ${live} live · newest first` : "Loading…"}</span>
        </div>
        <input
          className="search"
          type="search"
          placeholder="Search names, prompts, last replies, folders, tickets"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(HISTORY_PAGE);
          }}
        />
      </header>
      {error && <div className="toast">{error}</div>}
      {actionError && (
        <div className="toast">
          {actionError}
          <button className="btn ghost small" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {runs && found.length === 0 && <div className="zero big">{query ? "No chat matches." : "No chats yet."}</div>}
      {groups.map((g) => (
        <div className="stack" key={g.label}>
          <h2 className="section-title">{g.label}</h2>
          <div className="card flush">
            <ol className="history">
              {g.runs.map((r) => (
                <li key={r.sessionId} className={open === r.sessionId ? "open" : ""}>
                  <div className="h-row one-line">
                    <Dot tone={runTone(r)} pulse={r.status === "working"} />
                    <button className="h-title" onClick={() => setOpen(open === r.sessionId ? null : r.sessionId)} title={r.firstPrompt}>
                      {runTitle(r)}
                    </button>
                    {r.tickets.map((k) =>
                      tickets.has(k) ? (
                        <a key={k} className="key-link" href={href(`t:${k}`)} title={`${tickets.get(k)!.summary} · open on the board`}>
                          {k}
                        </a>
                      ) : (
                        <span key={k} className="key-link">
                          {k}
                        </span>
                      ),
                    )}
                    <span className="meta shrink">
                      {dirLabel(r.cwd)} · {plural(r.userMessageCount, "prompt")} · started {stamp(r.startedAt)}
                    </span>
                    <span className="grow" />
                    <span className="meta">{statusText(r, now)}</span>
                    <OpenTab run={r} onError={setActionError} className="btn ghost small" label="Open" />
                  </div>
                  {open !== r.sessionId && r.lastReply && <p className="h-last">{r.lastReply}</p>}
                  {/* A live chat reloads with the dashboard, so new turns show up; a finished one never changes. */}
                  {open === r.sessionId && <Chat sessionId={r.sessionId} refreshKey={r.status === "finished" ? r.lastActivityAt : data.generatedAt} />}
                </li>
              ))}
            </ol>
          </div>
        </div>
      ))}
      {found.length > limit && (
        <button className="btn" onClick={() => setLimit(limit + HISTORY_PAGE)}>
          Show {Math.min(HISTORY_PAGE, found.length - limit)} more of {found.length - limit}
        </button>
      )}
    </article>
  );
}

const NOTIFY_HINT = "A notification comes when an agent that worked for 45 s or more starts to wait for you. It needs this page open in a tab.";

function NotifyButton({ state, onEnable, onMute }: { state: NotifyState; onEnable: () => void; onMute: () => void }) {
  if (state === "unsupported") return null;
  if (state === "blocked") {
    return (
      <span className="meta tone-text-warn" title="Allow notifications for this site in Chrome (the icon to the left of the address), and for Google Chrome in macOS System Settings → Notifications.">
        Notifications blocked
      </span>
    );
  }
  if (state === "on") {
    return (
      <button className="btn ghost" onClick={onMute} title={`${NOTIFY_HINT} Click to mute.`}>
        Notifications on
      </button>
    );
  }
  return (
    <button className={`btn ${state === "ask" ? "" : "ghost"}`} onClick={onEnable} title={NOTIFY_HINT}>
      {state === "ask" ? "Turn on notifications" : "Notifications muted"}
    </button>
  );
}

// ---- conversations ------------------------------------------------------------------

/** A plain pi with no ticket context, run headless: this page is where you talk to it. */
function NewConversationForm() {
  const [message, setMessage] = useState("");
  const [cwd, setCwd] = useState("~");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (!message.trim() || starting) return;
    setStarting(true);
    try {
      const id = await api.newConversation(message, cwd);
      location.hash = `#/c:${encodeURIComponent(id)}`;
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  };
  return (
    <article className="workspace">
      <header className="ws-head">
        <h1>New conversation</h1>
        <span className="meta">A plain pi with no ticket context. It runs without a terminal, and you talk to it on this page.</span>
      </header>
      {error && <div className="toast">{error}</div>}
      <div className="composer">
        <textarea
          autoFocus
          rows={5}
          value={message}
          placeholder="What do you want to do?"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              start();
            }
          }}
        />
        <div className="composer-bar">
          <label className="folder">
            <span className="meta">in</span>
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
          </label>
          <button className="btn primary" onClick={start} disabled={starting || !message.trim() || !cwd.trim()}>
            {starting ? "Starting…" : "Start"} <Kbd>⌘↵</Kbd>
          </button>
        </div>
      </div>
    </article>
  );
}

function ConversationView({ sessionId, data, now }: { sessionId: string; data: Dashboard; now: number }) {
  const run = useMemo(() => [...data.myTickets, ...data.otherTickets].flatMap((g) => g.runs).concat(data.unlinkedRuns).find((r) => r.sessionId === sessionId), [data, sessionId]);
  const [error, setError] = useState<string | null>(null);
  // A diagram can link to a conversation older than the board's window.
  const old = useLoad(() => (run ? Promise.resolve(null) : api.transcript(sessionId)), run ? "live" : `${sessionId} ${data.generatedAt}`);
  const diagrams = data.diagrams.filter((d) => d.sessionId === sessionId);
  const end = useRef<HTMLDivElement>(null);
  // New turns land at the bottom, next to the reply box.
  // A block body: Chrome's scrollIntoView returns a Promise, which React would call as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [run?.lastActivityAt]);
  return (
    <article className="workspace">
      <header className="ws-head">
        <h1>{run ? runTitle(run) : old.value ? "Conversation" : "New conversation"}</h1>
        <div className="ws-meta">
          {run ? (
            <>
              <Dot tone={runTone(run)} pulse={run.status === "working"} />
              <span className="meta">
                {statusText(run, now)} · {dirLabel(run.cwd)} · {plural(run.userMessageCount, "prompt")}
              </span>
              {run.headless ? (
                <button className="btn ghost small" title="Stop this pi process. Resume here continues it later." onClick={async () => setError(await api.endConversation(sessionId))}>
                  End conversation
                </button>
              ) : (
                <OpenTab run={run} onError={setError} className="btn ghost small" />
              )}
            </>
          ) : old.value ? (
            <span className="meta">An older conversation, from its log</span>
          ) : (
            <span className="meta">Starting pi…</span>
          )}
        </div>
      </header>
      {error && <div className="toast">{error}</div>}
      {/* The run shows once pi saved the first message; until then there is no chat to load. */}
      {diagrams.length > 0 && (
        <div className="stack">
          <h2 className="section-title">Diagrams · {diagrams.length}</h2>
          <DiagramCards diagrams={diagrams} now={now} showTicket />
        </div>
      )}
      {run && <Chat sessionId={sessionId} refreshKey={run.lastActivityAt + run.status} />}
      {!run && old.value && <Chat sessionId={sessionId} refreshKey="old" />}
      {run && <LivePanel run={run} now={now} onError={setError} working="The agent is working…" />}
      {run && run.status !== "finished" && <Composer run={run} onError={setError} focusSignal={0} />}
      {run?.status === "finished" && <p className="meta">{resuming(sessionId) ? "Starting pi…" : "This conversation ended. Resume here (at the top) continues it on this page, and Copy resume in a terminal."}</p>}
      <div ref={end} />
    </article>
  );
}

// ---- help ---------------------------------------------------------------------------

const KEYS: [string, string][] = [
  ["J / ↓", "Next item (on PRs and History, J: next row)"],
  ["K / ↑", "Previous item (on PRs and History, K: previous row)"],
  ["↵", "On PRs and History: open the selected row"],
  ["T", "Show or hide the ticket's description and comments"],
  ["E", "Done for now (comes back when something changes)"],
  ["Z", "Snooze the ticket (comes back at the time you pick)"],
  ["R", "Reply to the agent"],
  ["O", "Open the agent's iTerm tab, or its page if it has no tab"],
  ["S", "Draft next steps"],
  ["N", "Add a note"],
  ["A", "Start a new agent with this ticket's context"],
  ["C", "Start a new conversation with pi on its own page, with no context"],
  ["V", "Switch the board between the queue and the kanban"],
  ["↵", "On the kanban: open the selected card's workspace"],
  ["⌘↵", "Send the reply"],
  ["Esc", "Leave the reply box"],
  ["?", "Show or hide this help"],
];

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="help" onClick={(e) => e.stopPropagation()}>
        <h3>Keyboard</h3>
        <dl>
          {KEYS.map(([k, v]) => (
            <div key={k}>
              <dt>
                <Kbd>{k}</Kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

// ---- page ---------------------------------------------------------------------------

export function App() {
  const { data, error, loading, refresh } = useDashboard();
  const notify = useWaitNotifications(data);
  const now = useNow(1_000);
  const doneForNow = useDoneForNow();
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const view = route.view;
  // The other views keep the board's ref, so going back lands on the same entry.
  const [boardRef, setBoardRef] = useState<string | null>(() => (route.view === "board" ? route.ref : null));
  const [help, setHelp] = useState(false);
  const [focusSignal, setFocusSignal] = useState(0);
  const [noteSignal, setNoteSignal] = useState(0);
  const [agentSignal, setAgentSignal] = useState(0);
  const [snoozeSignal, setSnoozeSignal] = useState(0);
  const [boardMode, setBoardMode] = useBoardMode();
  // On the kanban, the workspace opens in a drawer over the columns when you pick a card.
  const [drawer, setDrawer] = useState(() => route.view === "board" && !!route.ref);

  const subjects = useMemo(() => (data ? buildSubjects(data) : new Map<string, Subject>()), [data]);
  const until = (s: Subject) => (s.ticket ? data?.snoozedUntil[s.ticket.ticket.key] : undefined);
  const ticketSnoozed = (s: Subject) => isSnoozed(until(s), now);
  // A snoozed ticket leaves every other section until its time comes, whatever its signals say.
  const snoozedList = [...subjects.values()].filter(ticketSnoozed).sort((a, b) => until(a)!.localeCompare(until(b)!));
  const all = [...subjects.values()].filter((s) => !ticketSnoozed(s));
  const ranked = all.filter(actionable).sort((a, b) => lead(b)!.score - lead(a)!.score);
  const queue = ranked.filter((s) => !doneForNow.isDone(s));
  const done = ranked.filter((s) => doneForNow.isDone(s));
  // Only context left, such as a PR out for review: the ball is with someone else.
  const othersTurn = all.filter((s) => s.items.length && !actionable(s) && !isDone(s)).sort((a, b) => lead(b)!.score - lead(a)!.score);
  const working = all.filter((s) => !s.items.length && liveRuns(s).length && !isDone(s));
  // Closed in Jira, but agents still open on it: worth a glance to close the tabs, never a task.
  const doneInJira = all.filter((s) => isDone(s) && (s.items.length || liveRuns(s).length));
  const quiet = data ? data.myTickets.map((g) => subjects.get(`t:${g.ticket.key}`)!).filter((s) => !ticketSnoozed(s) && !s.items.length && !liveRuns(s).length) : [];
  const order = [...queue, ...othersTurn, ...working, ...done, ...doneInJira, ...quiet, ...snoozedList];

  const target = data && boardRef ? resolveBoardRef(boardRef, data, new Set(subjects.keys())) : null;
  const selected = (target && subjects.get(target.subjectId)) || queue[0] || order[0] || null;

  useEffect(() => {
    const onHash = () => {
      const next = parseHash(location.hash);
      setRoute(next);
      if (next.view === "board") {
        setBoardRef(next.ref);
        if (next.ref) setDrawer(true);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = useCallback((id: string) => {
    setBoardRef(id);
    history.replaceState(null, "", href(id));
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (!order.length) return;
      const i = selected ? order.findIndex((s) => s.id === selected.id) : -1;
      select(order[Math.max(0, Math.min(order.length - 1, i + delta))].id);
    },
    [order, selected, select],
  );

  const doneAndAdvance = useCallback(() => {
    if (!selected || !actionable(selected)) return;
    const i = queue.findIndex((s) => s.id === selected.id);
    const next = queue[i + 1] ?? queue[i - 1];
    doneForNow.markDone(selected);
    if (next) select(next.id);
  }, [selected, queue, doneForNow, select]);

  // The snoozed entry is still in `order` until the next load, so step past it.
  const advanceFrom = useCallback(
    (id: string) => {
      const rest = order.filter((s) => s.id === id || !ticketSnoozed(s));
      const i = rest.findIndex((s) => s.id === id);
      const next = rest[i + 1] ?? rest[i - 1];
      if (next && next.id !== id) select(next.id);
    },
    [order, select],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((view === "prs" || view === "history") && rowKey(e.key)) return void e.preventDefault();
      if (view !== "board" && e.key !== "?" && e.key !== "Escape") return;
      if (e.key === "j" || e.key === "ArrowDown") move(1);
      else if (e.key === "k" || e.key === "ArrowUp") move(-1);
      else if (e.key === "e") doneAndAdvance();
      else if (e.key === "z" && selected?.ticket) setSnoozeSignal((n) => n + 1);
      else if (e.key === "?") setHelp((h) => !h);
      else if (e.key === "Escape") {
        if (help) setHelp(false);
        else setDrawer(false);
      } else if (e.key === "v") setBoardMode(boardMode === "queue" ? "kanban" : "queue");
      else if (e.key === "Enter" && boardMode === "kanban" && !drawer && selected) setDrawer(true);
      else if (e.key === "r") setFocusSignal((n) => n + 1);
      else if (e.key === "n" && selected?.ticket) setNoteSignal((n) => n + 1);
      else if (e.key === "a" && selected?.ticket) setAgentSignal((n) => n + 1);
      else if (e.key === "c") location.hash = "#/c";
      else if (e.key === "o" && selected) {
        const run = primaryRun(selected);
        if (run?.headless) location.hash = `#/c:${encodeURIComponent(run.sessionId)}`;
        else if (run?.itermSessionId) api.focusTab(run.sessionId);
      } else if (e.key === "s" && selected?.ticket) {
        const st = data?.summaries[selected.ticket.ticket.key]?.latest;
        if (st?.status !== "in_progress") api.summarize(selected.ticket.ticket.key, false);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, doneAndAdvance, selected, data, view, help, boardMode, setBoardMode, drawer]);

  useEffect(() => {
    const waiting = data?.counts.awaiting_input ?? 0;
    document.title = queue.length ? `(${queue.length}) agent-dash` : waiting ? `(${waiting}) agent-dash` : "agent-dash";
  }, [data, queue.length]);

  if (!data) return <main className="loading">{error ? <pre className="error">{error}</pre> : <span className="shimmer wide" />}</main>;

  const waitingRuns = data.counts.awaiting_input;
  const workingRuns = data.counts.working;
  const position = selected && queue.includes(selected) ? `${queue.indexOf(selected) + 1} of ${queue.length} in the queue` : null;
  const sources = Object.entries(data.sources);
  const down = sources.filter(([, h]) => !h.ok);
  const openPrs = data.prs.filter((p) => p.state === "open").length;

  const workspace = (
    <>
      {!data.extensionInstalled && (
        <p className="banner">
          Run <code>pnpm install-extension</code> to get exact statuses and replies from here.
        </p>
      )}
      {boardRef && !target && (
        <p className="banner">
          <code>{boardRef}</code> is not on the board. It may be older than 14 days, or closed: look for it in <a href="#/history">History</a>.
        </p>
      )}
      {selected ? (
        <Workspace
          s={selected}
          data={data}
          now={now}
          position={position}
          doneForNow={doneForNow.isDone(selected)}
          onDoneForNow={doneAndAdvance}
          onWake={() => doneForNow.wake(selected)}
          onSnoozed={() => advanceFrom(selected.id)}
          snoozeSignal={snoozeSignal}
          focusSignal={focusSignal}
          noteSignal={noteSignal}
          agentSignal={agentSignal}
          anchor={target?.anchor ?? null}
        />
      ) : (
        <div className="zero big">Nothing to show.</div>
      )}
    </>
  );
  const newConversation = (
    <a className="btn" href="#/c" title="Start a plain pi with no ticket context, and talk to it on its own page">
      + New conversation <Kbd>C</Kbd>
    </a>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          agent-dash
          <nav className="views" aria-label="Views">
            <a href={selected ? href(selected.id) : "#/"} className={view === "board" ? "active" : ""} aria-current={view === "board" ? "page" : undefined}>
              Board {queue.length > 0 && <span className="count">{queue.length}</span>}
            </a>
            <a href="#/actions" className={view === "actions" ? "active" : ""} aria-current={view === "actions" ? "page" : undefined}>
              Actions {data.actions.length > 0 && <span className="count">{data.actions.length}</span>}
            </a>
            <a href="#/prs" className={view === "prs" ? "active" : ""} aria-current={view === "prs" ? "page" : undefined}>
              PRs {openPrs > 0 && <span className="count">{openPrs}</span>}
            </a>
            <a href="#/history" className={view === "history" ? "active" : ""} aria-current={view === "history" ? "page" : undefined}>
              History
            </a>
            <a href="#/diagrams" className={view === "diagrams" || view === "diagram" ? "active" : ""} aria-current={view === "diagrams" ? "page" : undefined}>
              Diagrams {data.diagrams.length > 0 && <span className="count">{data.diagrams.length}</span>}
            </a>
          </nav>
        </div>
        <div className="headline">
          <a href="#/needs" className={`needs-link ${view === "needs" ? "active" : ""}`} title="See what needs you, and where to act on each">
            {queue.length ? (
              <>
                <b>{plural(queue.length, "thing")}</b> need you
              </>
            ) : (
              <b>Nothing needs you</b>
            )}
          </a>
          <span className="sep">·</span>
          <span>
            <Dot tone="waiting" /> {waitingRuns} waiting
          </span>
          <span>
            <Dot tone="working" pulse={workingRuns > 0} /> {workingRuns} working
          </span>
        </div>
        <span className="grow" />
        <span className={`sources ${down.length ? "bad" : ""}`} title={sources.map(([n, h]) => `${n}: ${h.ok ? "ok" : h.error}`).join("\n")}>
          {down.length ? `${down.map(([n]) => n).join(", ")} down` : "Jira · GitHub · pi"}
          <Dot tone={down.length ? "bad" : "good"} />
        </span>
        <FixLogin sources={data.sources} onFixed={refresh} />
        <span className="meta">updated {age(data.generatedAt, now)} ago</span>
        <NotifyButton state={notify.state} onEnable={notify.enable} onMute={notify.mute} />
        <button className="btn ghost" onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <button className="btn ghost" onClick={() => setHelp(true)} title="Keyboard shortcuts">
          <Kbd>?</Kbd>
        </button>
      </header>

      {route.view === "needs" ? (
        <main className="main">
          <NeedsView queue={queue} hidden={done.length} data={data} now={now} />
        </main>
      ) : route.view === "actions" ? (
        <main className="main">
          <ActionsView data={data} now={now} focus={route.action} />
        </main>
      ) : route.view === "prs" ? (
        <main className="main">
          {route.pr ? <PrPanel key={route.pr} refId={route.pr} data={data} now={now} /> : <PrsView data={data} now={now} />}
        </main>
      ) : view === "history" ? (
        <main className="main">
          <HistoryView data={data} now={now} />
        </main>
      ) : route.view === "diagrams" ? (
        <main className="main">
          <DiagramsView data={data} now={now} />
        </main>
      ) : route.view === "diagram" ? (
        <main className="main">
          <DiagramView key={route.id} id={route.id} data={data} now={now} />
        </main>
      ) : route.view === "conversation" ? (
        <main className="main">
          {route.id ? <ConversationView key={route.id} sessionId={route.id} data={data} now={now} /> : <NewConversationForm />}
        </main>
      ) : boardMode === "kanban" ? (
        <div className="kanban-view">
          <div className="kanban-bar">
            {newConversation}
            <BoardModeToggle mode={boardMode} setMode={setBoardMode} />
            <span className="meta">Each card sits in the column of the furthest SDLC stage that its ticket reached.</span>
          </div>
          <KanbanBoard
            order={order}
            dim={new Set([...done, ...quiet, ...snoozedList])}
            ranks={new Map(queue.map((s, i) => [s, i + 1]))}
            selected={selected}
            onSelect={(s) => {
              select(s.id);
              setDrawer(true);
            }}
            data={data}
            now={now}
            until={until}
          />
          {drawer && selected && (
            <aside className="kanban-drawer" aria-label="Workspace">
              <button className="btn ghost small drawer-close" onClick={() => setDrawer(false)} title="Close the workspace (Esc)">
                Close <Kbd>Esc</Kbd>
              </button>
              {workspace}
            </aside>
          )}
        </div>
      ) : (
        <div className="columns">
          <nav className="rail">
            <div className="new-conversation">
              {newConversation}
              <BoardModeToggle mode={boardMode} setMode={setBoardMode} />
            </div>
            <RailSection title="Up next" count={queue.length}>
              {queue.map((s, i) => (
                <QueueItem key={s.id} s={s} rank={i + 1} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} summary={s.ticket ? data.summaries[s.ticket.ticket.key] : undefined} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            {queue.length === 0 && (
              <div className="zero">
                <div className="zero-mark">✓</div>
                <p>
                  <b>Queue clear.</b>
                  <br />
                  {workingRuns ? `${plural(workingRuns, "agent")} still working.` : "No agent is working."}
                </p>
              </div>
            )}
            <RailSection title="Waiting on others" count={othersTurn.length} hint="Someone else has the next move, such as a reviewer">
              {othersTurn.map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <RailSection title="Agents at work" count={working.length} hint="Live runs that need nothing from you yet">
              {working.map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <RailSection title="Done for now" count={done.length} defaultOpen={false} hint="Back in the queue when something changes">
              {done.map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <RailSection title="Snoozed" count={snoozedList.length} defaultOpen={false} hint="Back on the board at the time you picked">
              {snoozedList.map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} snoozedUntil={until(s)} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <RailSection title="Done in Jira" count={doneInJira.length} defaultOpen={false} hint="Closed tickets that still have agents open">
              {doneInJira.map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} />
              ))}
            </RailSection>
            <RailSection title="Quiet tickets" count={quiet.length} defaultOpen={false} hint="Your tickets with nothing going on">
              {quiet.map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <footer className="rail-foot">
              <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>E</Kbd> done · <Kbd>R</Kbd> reply · <Kbd>N</Kbd> note · <Kbd>?</Kbd> more
            </footer>
          </nav>

          <main className="main">
            {workspace}
          </main>
        </div>
      )}
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}
