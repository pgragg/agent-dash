import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitSummary } from "../../shared/nextSteps.ts";
import type { AttentionItem, AttentionKind, Dashboard, HistoryRun, NextStep, Note, PullRequest, Run, ThreadStatusChange, TicketGroup, TicketSummary, TicketSummaryState, Turn } from "../../shared/types.ts";
import { filterHistory, groupByDay } from "./history.ts";
import { countPrs, groupOpenPrs } from "./prs.ts";
import { age, api, dirLabel, dueLabel, elapsed, inline, Markdown, type NotifyState, plural, prName, resumeCommand, runTitle, shortDate, stamp, useDashboard, useNow, useWaitNotifications } from "./lib.tsx";

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

const SNOOZE_KEY = "agent-dash:done-for-now";

function useSnoozed() {
  const [map, setMap] = useState<Record<string, string>>(() => JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}"));
  const save = (next: Record<string, string>) => {
    setMap(next);
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(next));
  };
  return {
    isSnoozed: (s: Subject) => map[s.id] === s.fingerprint,
    snooze: (s: Subject) => save({ ...map, [s.id]: s.fingerprint }),
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
  if (!run.itermSessionId) return <CopyButton text={resumeCommand(run)} label="Copy resume" className={className} />;
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

function QueueItem({ s, selected, onSelect, now, summary, rank, notes = 0 }: { s: Subject; selected: boolean; onSelect: () => void; now: number; summary?: TicketSummaryState; rank?: number; notes?: number }) {
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
    <button ref={ref} className={`q-item ${selected ? "selected" : ""}`} onClick={onSelect} aria-current={selected}>
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

// ---- workspace (right side) ---------------------------------------------------------

const STALE_MS = 30 * 60_000;

/** One drafted step, with a button that starts a pi agent on it, with the same context as "Start a new agent". */
function StepRow({ ticket, step, cwd, onError }: { ticket: string; step: NextStep; cwd: string; onError: (m: string | null) => void }) {
  const [state, setState] = useState<"idle" | "starting" | "started">("idle");
  const start = async () => {
    setState("starting");
    const err = await api.startStep(ticket, step.id, cwd);
    onError(err);
    setState(err ? "idle" : "started");
  };
  return (
    <li className="step">
      <span className="step-body">{inline(step.body)}</span>
      <button className="btn ghost small" onClick={start} disabled={state !== "idle" || !cwd.trim()} title={`Start a pi agent in ${cwd} on this step, with this page as context`}>
        {state === "starting" ? "Starting…" : state === "started" ? "Started ✓" : "Start agent"}
      </button>
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
        <SummaryBody ticket={key} summary={shown} cwd={cwd} onError={onError} />
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
            <li key={n.id}>
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
  const [started, setStarted] = useState<number | null>(null);
  const [context, setContext] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusSignal) ref.current?.focus();
  }, [focusSignal]);
  const start = async () => {
    if (!message.trim()) return;
    setStarting(true);
    const err = await api.startAgent(key, message, cwd);
    setStarting(false);
    onError(err);
    if (!err) {
      setMessage("");
      setStarted(Date.now());
    }
  };
  return (
    <section className="card start-agent">
      <header className="card-head">
        <h3>Start a new agent</h3>
        <span className="meta">opens pi in a new iTerm tab, with this page as context</span>
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
          <button className="btn primary" onClick={start} disabled={starting || !message.trim() || !cwd.trim()}>
            {starting ? "Starting…" : "Start agent"} <Kbd>⌘↵</Kbd>
          </button>
        </div>
      </div>
      {started && Date.now() - started < 30_000 && <p className="meta started">Started in a new iTerm tab. It shows under Agents once it is running.</p>}
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

function Composer({ run, onError, focusSignal }: { run: Run; onError: (m: string | null) => void; focusSignal: number }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusSignal) ref.current?.focus();
  }, [focusSignal]);
  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    const err = await api.reply(run.sessionId, text);
    setSending(false);
    onError(err);
    if (!err) {
      setText("");
      setSentAt(Date.now());
    }
  };
  if (!run.canReply) {
    return (
      <div className="composer-off">
        To reply from here, run <code>/reload</code> once in this session. Until then, reply in its tab.
      </div>
    );
  }
  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={3}
        value={text}
        placeholder={run.status === "working" ? "Queue a message for when the agent finishes…" : "Reply to the agent…"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
          if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
        }}
      />
      <div className="composer-bar">
        <span className="meta">{sentAt && Date.now() - sentAt < 20_000 ? "Sent. The agent has your message." : `to ${dirLabel(run.cwd)} · ${run.sessionId.slice(-6)}`}</span>
        <button className="btn primary" onClick={send} disabled={sending || !text.trim()}>
          {sending ? "Sending…" : run.status === "working" ? "Queue" : "Send"} <Kbd>⌘↵</Kbd>
        </button>
      </div>
    </div>
  );
}

/** "Resolve" with an optional reason: the thread stops counting for this ticket. */
function ResolveButton({ ticket, run, onError, className = "btn ghost" }: { ticket: string; run: Run; onError: (m: string | null) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    onError(await api.setThread(ticket, run.sessionId, "resolved", reason));
    setSaving(false);
    setOpen(false);
    setReason("");
  };
  if (!open) {
    return (
      <button className={className} onClick={() => setOpen(true)} title={`This thread no longer matters to ${ticket}`}>
        Resolve
      </button>
    );
  }
  return (
    <span className="resolve-form">
      <input
        autoFocus
        value={reason}
        maxLength={500}
        placeholder="Why? (optional)"
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <button className="btn small primary" onClick={submit} disabled={saving}>
        Resolve
      </button>
      <button className="btn ghost small" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}

function AgentCard({ run, now, onError, focusSignal, primary, ticket }: { run: Run; now: number; onError: (m: string | null) => void; focusSignal: number; primary: boolean; ticket?: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = run.lastMessage.length > 900;
  return (
    <section className={`card agent tone-border-${runTone(run)}`}>
      <header className="card-head">
        <Dot tone={runTone(run)} pulse={run.status === "working"} />
        <div className="agent-title">
          <h3 title={run.firstPrompt}>{runTitle(run)}</h3>
          <span className="meta">
            {statusText(run, now)} · {dirLabel(run.cwd)} · {plural(run.userMessageCount, "prompt")}
          </span>
        </div>
        <span className="grow" />
        {ticket && <ResolveButton ticket={ticket} run={run} onError={onError} />}
        <OpenTab run={run} onError={onError} hotkey={primary} />
      </header>
      {run.lastMessage && (
        <div className={`agent-message ${long && !expanded ? "clamped" : ""}`}>
          <Markdown text={run.lastMessage} />
          {long && (
            <button className="btn ghost small expand" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Show the whole message"}
            </button>
          )}
        </div>
      )}
      {run.status !== "finished" && <Composer run={run} onError={onError} focusSignal={primary ? focusSignal : 0} />}
    </section>
  );
}

function PrRow({ pr, now }: { pr: PullRequest; now: number }) {
  const open = pr.state === "open";
  const review = pr.reviewDecision === "APPROVED" ? ["approved", "good"] : pr.reviewDecision === "CHANGES_REQUESTED" ? ["changes requested", "bad"] : pr.reviewDecision === "REVIEW_REQUIRED" ? ["needs review", "muted"] : null;
  return (
    <a className={`pr-row ${open ? "" : "closed"}`} href={pr.url} target="_blank" rel="noreferrer">
      <span className={`pr-state state-${pr.isDraft && open ? "draft" : pr.state}`}>{pr.isDraft && open ? "draft" : pr.state}</span>
      <span className="pr-name">{prName(pr.url)}</span>
      <span className="pr-title">{pr.title}</span>
      {open && pr.checks !== "none" && <span className={`tag tone-${pr.checks === "success" ? "good" : pr.checks === "failure" ? "bad" : "warn"}`}>CI {pr.checks}</span>}
      {open && review && <span className={`tag tone-${review[1]}`}>{review[0]}</span>}
      {open && pr.mergeable === "CONFLICTING" && <span className="tag tone-bad">conflict</span>}
      <span className="meta">{age(pr.updatedAt, now)}</span>
    </a>
  );
}

function History({ runs: allRuns, now, onError, ticket, threads = {} }: { runs: Run[]; now: number; onError: (m: string | null) => void; ticket?: string; threads?: Record<string, ThreadStatusChange> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const runs = allRuns.filter((r) => threads[r.sessionId]?.status !== "resolved");
  const resolved = allRuns.filter((r) => threads[r.sessionId]?.status === "resolved");
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
        <li key={r.sessionId} className={open === r.sessionId ? "open" : ""}>
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
            {ticket && <ResolveButton ticket={ticket} run={r} onError={onError} className="btn ghost small" />}
            <OpenTab run={r} onError={onError} className="btn ghost small" label="Open" />
          </div>
          {open === r.sessionId && r.lastMessage && (
            <div className="h-message">
              <Markdown text={r.lastMessage} />
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
            <li key={r.sessionId} className="resolved">
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

function Workspace({ s, data, now, position, snoozed, onSnooze, onWake, focusSignal, noteSignal, agentSignal }: {
  s: Subject;
  data: Dashboard;
  now: number;
  position: string | null;
  snoozed: boolean;
  onSnooze: () => void;
  onWake: () => void;
  focusSignal: number;
  noteSignal: number;
  agentSignal: number;
}) {
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
            <a className="key-link" href={s.prUrl} target="_blank" rel="noreferrer">
              {prName(s.prUrl)} ↗
            </a>
          )}
          <span className="grow" />
          {actionable(s) &&
            (snoozed ? (
              <button className="btn ghost" onClick={onWake}>
                Back to the queue
              </button>
            ) : (
              <button className="btn" onClick={onSnooze} title="Hide until something about it changes">
                Done for now <Kbd>E</Kbd>
              </button>
            ))}
        </div>
        {s.items.length > 0 && (
          <ul className="why">
            {s.items.map((a, i) => (
              <li key={i}>
                <Dot tone={KIND[a.kind].tone} />
                <span>{a.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </header>

      {error && (
        <div className="toast" role="alert">
          {error}
          <button className="btn ghost small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {s.ticket && <NextSteps s={s} state={data.summaries[s.ticket.ticket.key]} notes={data.notes[s.ticket.ticket.key] ?? []} now={now} cwd={cwd} onError={setError} />}

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

      {runs.length > 0 && (
        <div className="stack">
          <h2 className="section-title">History · {plural(runs.length, "run")}</h2>
          <div className="card flush">
            <History runs={runs} now={now} onError={setError} ticket={s.ticket?.ticket.key} threads={s.ticket?.threads} />
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
                  <a className="pr-group-title" href={`#/t:${encodeURIComponent(t.key)}`} title="Open on the board">
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
                  <div key={pr.url} className="pr-entry">
                    <PrRow pr={pr} now={now} />
                    {todo.length > 0 && (
                      <ul className="pr-why">
                        {todo.map((a) => (
                          <li key={a.kind}>
                            <Dot tone={KIND[a.kind].tone} />
                            <span>{a.reason}</span>
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
                        <a key={k} className="key-link" href={`#/t:${encodeURIComponent(k)}`} title={`${tickets.get(k)!.summary} · open on the board`}>
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

/** Opens a plain pi in a new iTerm tab, in the home folder, with no ticket context. */
function NewConversation({ signal }: { signal: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useCallback(async () => {
    setBusy(true);
    setError(await api.newConversation());
    setBusy(false);
  }, []);
  useEffect(() => {
    if (signal) start();
  }, [signal, start]);
  return (
    <div className="new-conversation">
      <button className="btn" onClick={start} disabled={busy} title="Open pi in a new iTerm tab, with no ticket context">
        {busy ? "Opening…" : "+ New conversation"} <Kbd>C</Kbd>
      </button>
      {error && <p className="new-conversation-error">{error}</p>}
    </div>
  );
}

// ---- help ---------------------------------------------------------------------------

const KEYS: [string, string][] = [
  ["J / ↓", "Next item"],
  ["K / ↑", "Previous item"],
  ["E", "Done for now (comes back when something changes)"],
  ["R", "Reply to the agent"],
  ["O", "Open the agent's iTerm tab"],
  ["S", "Draft next steps"],
  ["N", "Add a note"],
  ["A", "Start a new agent with this ticket's context"],
  ["C", "Start a new conversation with pi, with no context"],
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

type View = "board" | "prs" | "history";

/** `#/prs` and `#/history` are views. Anything else is the board, and `#/t:KEY` or `#/r:ID` selects an entry on it. */
function parseHash(): { view: View; id: string | null } {
  const path = decodeURIComponent(location.hash.slice(2));
  return path === "prs" || path === "history" ? { view: path, id: null } : { view: "board", id: path || null };
}

export function App() {
  const { data, error, loading, refresh } = useDashboard();
  const notify = useWaitNotifications(data);
  const now = useNow(1_000);
  const snoozed = useSnoozed();
  const [view, setView] = useState<View>(() => parseHash().view);
  const [selectedId, setSelectedId] = useState<string | null>(() => parseHash().id);
  const [help, setHelp] = useState(false);
  const [focusSignal, setFocusSignal] = useState(0);
  const [noteSignal, setNoteSignal] = useState(0);
  const [agentSignal, setAgentSignal] = useState(0);
  const [conversationSignal, setConversationSignal] = useState(0);

  const subjects = useMemo(() => (data ? buildSubjects(data) : new Map<string, Subject>()), [data]);
  const all = [...subjects.values()];
  const ranked = all.filter(actionable).sort((a, b) => lead(b)!.score - lead(a)!.score);
  const queue = ranked.filter((s) => !snoozed.isSnoozed(s));
  const done = ranked.filter((s) => snoozed.isSnoozed(s));
  // Only context left, such as a PR out for review: the ball is with someone else.
  const othersTurn = all.filter((s) => s.items.length && !actionable(s) && !isDone(s)).sort((a, b) => lead(b)!.score - lead(a)!.score);
  const working = all.filter((s) => !s.items.length && liveRuns(s).length && !isDone(s));
  // Closed in Jira, but agents still open on it: worth a glance to close the tabs, never a task.
  const doneInJira = all.filter((s) => isDone(s) && (s.items.length || liveRuns(s).length));
  const quiet = data ? data.myTickets.map((g) => subjects.get(`t:${g.ticket.key}`)!).filter((s) => !s.items.length && !liveRuns(s).length) : [];
  const order = [...queue, ...othersTurn, ...working, ...done, ...doneInJira, ...quiet];

  const selected = (selectedId && subjects.get(selectedId)) || queue[0] || order[0] || null;

  useEffect(() => {
    const onHash = () => {
      const { view, id } = parseHash();
      setView(view);
      // The other views keep the board's selection, so going back lands on the same entry.
      if (view === "board") setSelectedId(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    history.replaceState(null, "", `#/${encodeURIComponent(id)}`);
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (!order.length) return;
      const i = selected ? order.findIndex((s) => s.id === selected.id) : -1;
      select(order[Math.max(0, Math.min(order.length - 1, i + delta))].id);
    },
    [order, selected, select],
  );

  const snoozeAndAdvance = useCallback(() => {
    if (!selected || !actionable(selected)) return;
    const i = queue.findIndex((s) => s.id === selected.id);
    const next = queue[i + 1] ?? queue[i - 1];
    snoozed.snooze(selected);
    if (next) select(next.id);
  }, [selected, queue, snoozed, select]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (view !== "board" && e.key !== "?" && e.key !== "Escape") return;
      if (e.key === "j" || e.key === "ArrowDown") move(1);
      else if (e.key === "k" || e.key === "ArrowUp") move(-1);
      else if (e.key === "e") snoozeAndAdvance();
      else if (e.key === "?") setHelp((h) => !h);
      else if (e.key === "Escape") setHelp(false);
      else if (e.key === "r") setFocusSignal((n) => n + 1);
      else if (e.key === "n" && selected?.ticket) setNoteSignal((n) => n + 1);
      else if (e.key === "a" && selected?.ticket) setAgentSignal((n) => n + 1);
      else if (e.key === "c") setConversationSignal((n) => n + 1);
      else if (e.key === "o" && selected) {
        const run = primaryRun(selected);
        if (run?.itermSessionId) api.focusTab(run.sessionId);
      } else if (e.key === "s" && selected?.ticket) {
        const st = data?.summaries[selected.ticket.ticket.key]?.latest;
        if (st?.status !== "in_progress") api.summarize(selected.ticket.ticket.key, false);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, snoozeAndAdvance, selected, data, view]);

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          agent-dash
          <nav className="views" aria-label="Views">
            <a href={selected ? `#/${encodeURIComponent(selected.id)}` : "#/"} className={view === "board" ? "active" : ""} aria-current={view === "board" ? "page" : undefined}>
              Board {queue.length > 0 && <span className="count">{queue.length}</span>}
            </a>
            <a href="#/prs" className={view === "prs" ? "active" : ""} aria-current={view === "prs" ? "page" : undefined}>
              PRs {openPrs > 0 && <span className="count">{openPrs}</span>}
            </a>
            <a href="#/history" className={view === "history" ? "active" : ""} aria-current={view === "history" ? "page" : undefined}>
              History
            </a>
          </nav>
        </div>
        <div className="headline">
          {queue.length ? (
            <>
              <b>{plural(queue.length, "thing")}</b> need you
            </>
          ) : (
            <b>Nothing needs you</b>
          )}
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
        <span className="meta">updated {age(data.generatedAt, now)} ago</span>
        <NotifyButton state={notify.state} onEnable={notify.enable} onMute={notify.mute} />
        <button className="btn ghost" onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <button className="btn ghost" onClick={() => setHelp(true)} title="Keyboard shortcuts">
          <Kbd>?</Kbd>
        </button>
      </header>

      {view === "prs" ? (
        <main className="main">
          <PrsView data={data} now={now} />
        </main>
      ) : view === "history" ? (
        <main className="main">
          <HistoryView data={data} now={now} />
        </main>
      ) : (
        <div className="columns">
          <nav className="rail">
            <NewConversation signal={conversationSignal} />
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
            {!data.extensionInstalled && (
              <p className="banner">
                Run <code>pnpm install-extension</code> to get exact statuses and replies from here.
              </p>
            )}
            {selected ? (
              <Workspace
                s={selected}
                data={data}
                now={now}
                position={position}
                snoozed={snoozed.isSnoozed(selected)}
                onSnooze={snoozeAndAdvance}
                onWake={() => snoozed.wake(selected)}
                focusSignal={focusSignal}
                noteSignal={noteSignal}
                agentSignal={agentSignal}
              />
            ) : (
              <div className="zero big">Nothing to show.</div>
            )}
          </main>
        </div>
      )}
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}
