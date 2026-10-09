import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentLabel } from "../../shared/team.ts";
import { type MoveTarget, moveStepTarget, moveTargets } from "../../shared/jiraVerbs.ts";
import { splitSummary } from "../../shared/nextSteps.ts";
import { awaitsOwner, ownerWaitText } from "../../shared/ownerApproval.ts";
import { prRef } from "../../shared/refs.ts";
import { hideUrls } from "../../shared/runTitle.ts";
import { READ_FEEDBACK, REVIEW_AND_MERGE } from "../../shared/prVerbs.ts";
import { type AttentionItem, type AttentionKind, type ConversationSummary, type Dashboard, type HistoryRun, type NextStep, type Note, PARKED_ASK_CHARS, type ParkedRun, type PullRequest, type Run, type LaneMode, type ThreadStatusChange, type TicketGroup, type TicketSummary, type TicketSummaryState } from "../../shared/types.ts";
import { conversationHash, launchAgent, ResumeHere, resuming } from "./agents.tsx";
import { ParkedAskList, ParkedAsksPane, ParkedView } from "./parked.tsx";
import { askKey, askRef, type AskGroup, needsYouCount, parkedAsks, splitParked } from "./parkedRows.ts";
import { CADDY_HTTP, CADDY_HTTPS, caddyCommands, cleanHost, cleanPort, rootScript, undoCommands } from "./localUrl.ts";
import { SettingsView, SetupBanner } from "./settings.tsx";
import { FIRST_LANES, type LaneDraft, LanesCard, LanesEditor, type LaneRun, WorktreesView } from "./lanes.tsx";
import { filterHistory, groupByDay } from "./history.ts";
import { PrPanel, PrVerbButton } from "./prPanel.tsx";
import { ciTag } from "./prView.ts";
import { countPrs, groupOpenPrs } from "./prs.ts";
import { age, api, dirLabel, dueLabel, elapsed, inline, Markdown, type NotifyState, plural, prName, lastSeen, resumeCommand, runTitle, shortDate, stamp, useDashboard, useFlash, useLastMessage, useLook, useNow, usePageFocus, useWaitNotifications } from "./lib.tsx";
import { Composer, LivePanel } from "./liveControl.tsx";
import { needStep } from "./needs.ts";
import { agentFinished, agentState, agentWaitsOnReview, asksNothing, isNewSince, readySummary, runsOf, summaryText, waitingOnYou } from "./notify.ts";
import { needsNothing } from "../../shared/conversationSummary.ts";
import { href, humanAge, parseHash, redirectHash, resolveBoardRef, type Route } from "./routes.ts";
import { FixLogin } from "./fixLogin.tsx";
import { rowKey } from "./rowNav.ts";
import { ReviewRequest, useReviewDrafts } from "./reviewRequest.tsx";
import { wantsReviewRequest } from "../../shared/reviewRequest.ts";
import { SdlcBar, SmoketestAction, SmoketestName, Smoketests } from "./sdlc.tsx";
import { type SmoketestRow, smoketestRow } from "./smoketestRow.ts";
import { groupWhy, statusWord, UPDATES_SHOWN } from "./whyGroups.ts";
import { Chat, useLoad } from "./chat.tsx";
import { ConversationGist } from "./gist.tsx";
import { SlackQuotes } from "./slackQuotes.tsx";
import { DueDateVerb, MoveButton, TicketPanel, useTicketDetail } from "./ticketPanel.tsx";
import { Documentation, DocumentsView, DocumentView, TicketSummaryDoc, WriteTicketSummary } from "./documents.tsx";
import { WikiListView, WikiNoteView } from "./wiki.tsx";
import { SessionScope } from "./mermaid.tsx";
import { CardStep } from "./cardStep.tsx";
import { type BoardMode, kanbanColumns, type Searchable, searchCards, stageOf, useBoardMode } from "./kanban.ts";
import { starredFirst } from "./star.ts";
import { FullScreenButton, ResizeHandle, useViewWidth, ViewTools, ViewToolsSlot } from "./resizeView.tsx";
import { rowName, rowType } from "./whyRow.ts";
import { DEFAULT_SNOOZE, isSnoozed, SNOOZE_OPTIONS, type SnoozeOption, snoozeUntil, untilLabel } from "./snooze.ts";
import { tabTitle } from "./tabTitle.ts";

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
  items: Item[];
  /** Changes whenever a signal changes, so "done for now" expires on news. */
  fingerprint: string;
}

/** A signal, with the summary of its agent's conversation when it has one. */
interface Item extends AttentionItem {
  /** The summary for the notification. Null until it is ready, so nothing old shows. */
  gist: string | null;
  /** The agent stopped, and its summary says it needs nothing from you. */
  finished: boolean;
  /** The agent stopped, and its only ask is that a reviewer approves its PR. */
  waitsOnReview: boolean;
}

const KIND: Record<AttentionKind, { title: string; tone: "waiting" | "working" | "bad" | "warn" | "good" | "muted" }> = {
  run_error: { title: "Agent hit an error", tone: "bad" },
  awaiting_input: { title: "Agent is waiting on you", tone: "waiting" },
  changes_requested: { title: "Changes requested", tone: "bad" },
  ci_failing: { title: "CI is failing", tone: "bad" },
  merge_conflict: { title: "Merge conflict", tone: "bad" },
  ready_to_merge: { title: "Ready to merge", tone: "good" },
  approved_with_feedback: { title: "Approved, with feedback", tone: "warn" },
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
  approved_with_feedback: "feedback",
  in_review: "in review",
  overdue: "overdue",
  due_soon: "due soon",
  stalled: "stalled",
};

const FINISHED = { title: "Agent finished", tone: "good", short: "finished" } as const;
const WAITS_ON_REVIEW = { title: "Agent waits on a PR review", tone: "working", short: "review" } as const;

/** How a signal shows: "Agent finished" for an agent that needs nothing, else its kind. */
function look(a: Item): { title: string; tone: string; short: string } {
  if (a.waitsOnReview) return WAITS_ON_REVIEW;
  return a.finished ? FINISHED : { ...KIND[a.kind], short: SHORT[a.kind] };
}

function buildSubjects(d: Dashboard): Map<string, Subject> {
  const out = new Map<string, Subject>();
  const add = (id: string, init: Omit<Subject, "id" | "items" | "fingerprint">) => {
    if (!out.has(id)) out.set(id, { id, items: [], fingerprint: "", ...init });
    return out.get(id)!;
  };
  for (const g of [...d.myTickets, ...d.otherTickets]) add(`t:${g.ticket.key}`, { ticket: g, run: null, prUrl: null });
  for (const r of d.unlinkedRuns) add(`r:${r.sessionId}`, { ticket: null, run: r, prUrl: null });
  const runs = new Map(runsOf(d).map((r) => [r.sessionId, r]));
  for (const a of d.attention) {
    const id = a.ticketKey ? `t:${a.ticketKey}` : a.sessionId ? `r:${a.sessionId}` : `p:${a.prUrl}`;
    const s = out.get(id) ?? add(id, { ticket: null, run: a.run ?? null, prUrl: a.prUrl ?? null });
    const agent = a.kind === "awaiting_input" || a.kind === "run_error";
    const summary = agent && a.sessionId ? d.conversationSummaries[a.sessionId] : undefined;
    const run = runs.get(a.sessionId ?? "");
    const finished = a.kind === "awaiting_input" && agentFinished(run, summary);
    // The reviewer has the next move, so the stop waits on others, as a PR out for review does.
    const review = a.kind === "awaiting_input" && agentWaitsOnReview(run, summary);
    const name = run && `“${runTitle(run).slice(0, 60)}”`;
    // The server's reason says "is waiting for you", which a finished agent is not.
    const reason = review && name ? `${name} waits on a PR review` : finished && name ? `${name} finished ${age(run.statusSince, Date.parse(d.generatedAt))} ago` : a.reason;
    const status = review ? "waits on review" : finished ? "finished" : a.status;
    // A finished agent needs nothing, so it is not on your queue, unless its smoketest still needs you (a plan to Confirm, a failed run).
    const idle = finished && !smoketestRow(a.sessionId, a.ticketKey ? (d.sdlcEvents[a.ticketKey] ?? []) : [], { asked: false, finished: true })?.needsYou;
    // A stalled ticket whose newest agent asks nothing of you is quiet, not a task.
    const settled = a.kind === "stalled" && asksNothing(d.conversationSummaries[a.sessionId ?? ""]);
    s.items.push({ ...a, info: a.info || review || idle || settled, reason, status, gist: summaryText(summary), finished, waitsOnReview: review });
  }
  for (const s of out.values()) s.fingerprint = s.items.map((a) => `${a.kind}${a.finished ? ":finished" : ""}${a.waitsOnReview ? ":review" : ""}@${a.updatedAt}`).join("|");
  return out;
}

/** The ticket is Done in its tracker. */
function isDone(s: Subject): boolean {
  return s.ticket?.ticket.statusCategory === "done";
}

/** Something here needs you, not only someone else. */
function actionable(s: Subject): boolean {
  return s.items.some((a) => !a.info);
}

/** Only agents that finished and need nothing: not your move, and not someone else's either. */
function onlyFinished(s: Subject): boolean {
  return s.items.length > 0 && s.items.every((a) => a.finished && a.info);
}

/** The item that leads: the most urgent one that needs you, else the first. */
function lead(s: Subject): Item | undefined {
  return s.items.find((a) => !a.info) ?? s.items[0];
}

/** One tag per label: two runs that both wait make one tag. */
function otherTags(s: Subject): { short: string; tone: string }[] {
  const top = lead(s);
  const tags = new Map(s.items.map((a) => [look(a).short, look(a).tone]));
  if (top) tags.delete(look(top).short);
  return [...tags].map(([short, tone]) => ({ short, tone }));
}

/** The tags next to the lead signal. */
function OtherTags({ s }: { s: Subject }) {
  return otherTags(s).map((t) => (
    <span key={t.short} className={`tag tone-${t.tone}`}>
      {t.short}
    </span>
  ));
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

/** "Agent · waiting 13h · <name>": what the row is, its state, and a link to it. */
function RowHead({ a, summary, pageTicket, status = a.status }: { a: Item; summary?: ConversationSummary; pageTicket?: string | null; status?: string }) {
  const name = rowName(a, summary, pageTicket);
  return (
    <span className="row-head">
      <TypeChip kind={a.kind} />
      <span className={`tag tone-${look(a).tone}`}>{status}</span>
      {name &&
        (name.ref ? (
          <a className="row-name" href={href(name.ref)} title={name.full}>
            {name.text}
          </a>
        ) : (
          <span className="row-name" title={name.full}>
            {name.text}
          </span>
        ))}
    </span>
  );
}

function TypeChip({ kind }: { kind: AttentionKind }) {
  return <span className="tag type-chip">{rowType(kind)}</span>;
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

/** With the run's conversation summary, an agent that only waits on a PR review says so: see `agentState`. */
function statusText(run: HistoryRun, now: number, summary?: ConversationSummary): string {
  const guess = run.statusSource === "heuristic" ? " (guess)" : "";
  if (agentState(run, summary) === "waits_on_review") return `waits on review ${age(run.statusSince, now)}`;
  if (run.status === "awaiting_input") return `waiting ${age(run.statusSince, now)}${guess}`;
  if (run.status === "working") return `working ${age(run.statusSince, now)}${guess}`;
  return `finished ${age(run.lastActivityAt, now)} ago`;
}

/** An agent that waits on review is blue, as a PR out for review is: the next move is the reviewer's. */
function runTone(run: HistoryRun, summary?: ConversationSummary): string {
  const state = agentState(run, summary);
  return run.endedInError ? "bad" : state === "awaiting_input" ? "waiting" : state === "working" || state === "waits_on_review" ? "working" : "muted";
}

/** A lane's agent state, from the ticket's runs. Null until pi saves the first message. */
function laneRun(s: Subject, sessionId: string, now: number, summary?: ConversationSummary): LaneRun | null {
  const run = s.ticket?.runs.find((r) => r.sessionId === sessionId);
  return run ? { tone: runTone(run, summary), text: statusText(run, now, summary), working: run.status === "working" } : null;
}

// ---- queue (left rail) --------------------------------------------------------------

function QueueItem({ s, selected, onSelect, now, summary, rank, notes = 0, snoozedUntil, card = false, dim = false, starred = false, need = null, footer }: { s: Subject; selected: boolean; onSelect: () => void; now: number; summary?: TicketSummaryState; rank?: number; notes?: number; snoozedUntil?: string; card?: boolean; dim?: boolean; starred?: boolean; need?: string | null; footer?: React.ReactNode }) {
  const top = lead(s);
  const run = primaryRun(s);
  const ref = useRef<HTMLButtonElement & HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const done = isDone(s);
  const headline = top ? look(top).title : run ? statusText(run, now) : s.ticket?.ticket.status ?? "";
  // On a Done ticket nothing is urgent, so the headline goes quiet and the green tag says why.
  const tone = done ? "muted" : top ? look(top).tone : run ? runTone(run) : "muted";
  const when = top?.kind === "awaiting_input" && run ? age(run.statusSince, now) : age(top?.updatedAt ?? run?.lastActivityAt ?? s.ticket?.ticket.updatedAt, now);
  const className = `q-item ${card ? "k-card" : ""} ${dim ? "dim" : ""} ${starred ? "starred" : ""} ${selected ? "selected" : ""}`;
  const body = (
    <>
      {starred && (
        <span className="q-star" title="Starred" aria-label="Starred">
          ★
        </span>
      )}
      <span className="q-rank">{rank ?? ""}</span>
      <span className="q-body">
        <span className="q-head">
          <Dot tone={tone} pulse={run?.status === "working"} />
          <span className={`q-headline tone-text-${tone}`}>{headline}</span>
          <span className="q-when">{when}</span>
        </span>
        <span className="q-title">{subjectTitle(s)}</span>
        {need && (
          <span className="q-need" title={need}>
            Needs from you: {need}
          </span>
        )}
        <span className="q-tags">
          {s.ticket && <span className="q-key">{s.ticket.ticket.key}</span>}
          {done && <span className="tag tone-good">done</span>}
          <OtherTags s={s} />
          {summary && !done && <span className="tag tone-muted" title="Next steps drafted">✦ next steps</span>}
          {notes > 0 && <span className="tag tone-muted" title={`${plural(notes, "note")}`}>✎ {notes}</span>}
          {snoozedUntil && <span className="tag tone-muted" title={new Date(snoozedUntil).toLocaleString()}>until {untilLabel(snoozedUntil, now)}</span>}
        </span>
        {footer && (
          // A click on the footer's own button does not also open the card.
          <span className="q-foot" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {footer}
          </span>
        )}
      </span>
    </>
  );
  if (!footer) {
    return (
      <button ref={ref} className={className} onClick={onSelect} aria-current={selected}>
        {body}
      </button>
    );
  }
  // A button cannot hold a button, so a card with a footer button is a div that acts as one.
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      className={className}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onSelect();
      }}
      aria-current={selected}
    >
      {body}
    </div>
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

/** One ticket's parked asks in the rail, or the asks with no ticket. The pane it opens has Send, Resume and Dismiss. */
function AskItem({ g, title, selected, onSelect, now }: { g: AskGroup; title: string; selected: boolean; onSelect: () => void; now: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const newest = g.rows.reduce((m, p) => (p.parkedAt > m.parkedAt ? p : m));
  const ask = newest.needs ?? newest.lastMessage.slice(-PARKED_ASK_CHARS);
  return (
    <button ref={ref} className={`q-item ${selected ? "selected" : ""}`} onClick={onSelect} aria-current={selected}>
      <span className="q-rank" />
      <span className="q-body">
        <span className="q-head">
          <Dot tone="waiting" />
          <span className="q-headline tone-text-waiting">{g.rows.length === 1 ? "A parked agent asks" : `${g.rows.length} parked agents ask`}</span>
          <span className="q-when">{age(newest.parkedAt, now)}</span>
        </span>
        <span className="q-title">{title}</span>
        <span className="q-need" title={ask}>
          Needs from you: {ask}
        </span>
        {g.key && (
          <span className="q-tags">
            <span className="q-key">{g.key}</span>
          </span>
        )}
      </span>
    </button>
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

/** What the kanban search reads on a card: its ticket keys, then its title, runs and PRs. */
function searchFields(s: Subject, data: Dashboard): Searchable {
  const runs = s.ticket ? s.ticket.runs : s.run ? [s.run] : [];
  const prs = s.ticket ? s.ticket.prs : data.prs.filter((p) => p.url === s.prUrl);
  return {
    keys: s.ticket ? [s.ticket.ticket.key] : [...runs.flatMap((r) => r.tickets), ...prs.flatMap((p) => p.tickets)],
    text: [s.ticket?.ticket.summary ?? "", ...runs.flatMap((r) => [r.name ?? "", r.title ?? "", r.firstPrompt, r.lastReply]), ...prs.flatMap((p) => [p.title, p.headRef, p.url])],
  };
}

/** The board's entries as cards, in the column of the SDLC stage that each ticket reached. */
function KanbanBoard({ order, dim, ranks, selected, onSelect, data, now, until, isStarred }: { order: Subject[]; dim: Set<Subject>; ranks: Map<Subject, number>; selected: Subject | null; onSelect: (s: Subject) => void; data: Dashboard; now: number; until: (s: Subject) => string | undefined; isStarred: (s: Subject) => boolean }) {
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
            {c.items.map((s) => {
              // The ticket's top next step, as a button, so you start it without opening the ticket. It shows once the server has decided what a click does.
              const step = s.ticket && !isDone(s) ? firstStep(data, s) : null;
              return (
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
                  starred={isStarred(s)}
                  footer={step?.action && <CardStep key={step.id} ticket={s.ticket!.ticket.key} status={s.ticket!.ticket.status} step={step} action={step.action} cwd={workFolders(s)[0]} />}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---- workspace (right side) ---------------------------------------------------------

const STALE_MS = 30 * 60_000;

/**
 * One drafted step, with a button that starts a pi agent on it, with the same context as "Start a
 * new agent". A step that only moves the ticket in its tracker gets a Move button: that needs no agent.
 */
function StepRow({ ticket, step, cwd, move, onError }: { ticket: string; step: NextStep; cwd: string; move: { target: MoveTarget; from: string; onMoved: () => void } | null; onError: (m: string | null) => void }) {
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
      {move && move.target.to === move.from ? <span className="tag tone-good">already {move.from}</span> : move ? <MoveButton ticket={ticket} target={move.target} from={move.from} onError={onError} onMoved={move.onMoved} /> : sessionId ? <a className="btn ghost small" href={conversationHash(sessionId)}>Started ✓ Open</a> : <button className="btn ghost small" onClick={(e) => start(e.altKey)} disabled={state !== "idle" || !cwd.trim()} title={`Start a pi agent in ${cwd} on this step, with this page as context. ⌥-click opens it in a new iTerm tab.`}>
        {state === "starting" ? "Starting…" : state === "started" ? "Started ✓" : "Start agent"}
      </button>}
    </li>
  );
}

function SummaryBody({ ticket, canMove, summary, cwd, onError }: { ticket: string; canMove: boolean; summary: TicketSummary; cwd: string; onError: (m: string | null) => void }) {
  // Read the transitions only when a step may be a move.
  const { detail, reload } = useTicketDetail(ticket, canMove && summary.steps.some((st) => /\bmov/i.test(st.body)));
  const moveFor = (st: NextStep) => {
    // The current status counts too, so a step that is out of date says so instead of starting an agent.
    const target = detail && moveStepTarget(st.body, ticket, [...moveTargets(detail.transitions, detail.status), { to: detail.status, via: null }]);
    return target ? { target, from: detail.status, onMoved: reload } : null;
  };
  if (!summary.steps.length) return <Markdown text={summary.summary ?? ""} />;
  const parts = splitSummary(summary.summary ?? "");
  return (
    <>
      <Markdown text={parts.before} />
      <ol className="steps">
        {summary.steps.map((st) => (
          <StepRow key={st.id} ticket={ticket} step={st} cwd={cwd} move={moveFor(st)} onError={onError} />
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
    <section className="card next-steps" id="next-steps">
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
                Reading the ticket, PRs, Slack and agent history… <b>{elapsed(latest!.requestedAt, now)}</b>
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
          <SummaryBody ticket={key} canMove={s.ticket!.ticket.source.move} summary={shown} cwd={cwd} onError={onError} />
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
  const [started, setStarted] = useState<{ at: number; sessionId: string | null; lanes?: boolean } | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [context, setContext] = useState<string | null>(null);
  const [parallel, setParallel] = useState(false);
  const [lanes, setLanes] = useState<LaneDraft[]>(FIRST_LANES);
  const [laneMode, setLaneMode] = useState<LaneMode>("land");
  const [base, setBase] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusSignal) ref.current?.focus();
  }, [focusSignal]);
  const ready = parallel ? lanes.every((l) => l.name.trim() && l.message.trim()) : !!message.trim();
  const start = async () => {
    if (!ready) return;
    setStarting(true);
    try {
      // Lanes are always headless; their sessions show on the Parallel lanes card.
      const body = parallel ? { message, cwd, lanes, laneMode, base: base.trim() || undefined } : { message, cwd, terminal };
      const sessionId = await launchAgent(key, body);
      onError(null);
      setMessage("");
      if (parallel) setLanes(FIRST_LANES);
      setStarted({ at: Date.now(), sessionId, lanes: parallel });
    } catch (err) {
      onError((err as Error).message);
    }
    setStarting(false);
  };
  return (
    <section className="card start-agent">
      <header className="card-head">
        <h3>Start a new agent</h3>
        <span className="meta">starts {agentLabel()} with this page as context; you talk to it here</span>
      </header>
      <div className="composer">
        <textarea
          ref={ref}
          rows={3}
          value={message}
          placeholder={parallel ? `Brief that every lane on ${key} gets (optional)…` : `First message for the new agent on ${key}…`}
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
          <label className="meta" title="Start one agent per lane, each in its own git worktree of this folder's repo">
            <input type="checkbox" checked={parallel} onChange={(e) => setParallel(e.target.checked)} /> parallel lanes
          </label>
          {!parallel && (
            <label className="meta" title={`Open ${agentLabel()} in a new iTerm tab instead of on this page`}>
              <input type="checkbox" checked={terminal} onChange={(e) => setTerminal(e.target.checked)} /> in iTerm
            </label>
          )}
          <button className="btn primary" onClick={start} disabled={starting || !ready || !cwd.trim()}>
            {starting ? "Starting…" : parallel ? `Start ${lanes.length} lanes` : "Start agent"} <Kbd>⌘↵</Kbd>
          </button>
        </div>
        {parallel && <LanesEditor ticket={key} lanes={lanes} setLanes={setLanes} mode={laneMode} setMode={setLaneMode} base={base} setBase={setBase} />}
      </div>
      {started && Date.now() - started.at < 30_000 && (
        <p className="meta started">
          {started.lanes ? "Started. Each lane shows under Parallel lanes, with its own worktree and agent." : started.sessionId ? <>Started. It shows under Agents once {agentLabel()} saves the first message, or <a href={conversationHash(started.sessionId)}>open its page</a>.</> : "Started in a new iTerm tab. It shows under Agents once it is running."}
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

function AgentCard({ run, now, onError, focusSignal, primary, ticket, summary }: { run: Run; now: number; onError: (m: string | null) => void; focusSignal: number; primary: boolean; ticket?: string; summary?: ConversationSummary }) {
  const [expanded, setExpanded] = useState(false);
  const [chat, setChat] = useState(false);
  // The card opens on its summary; a click shows the last message and the chat under it.
  const [detailsChoice, setDetails] = useState<boolean | null>(null);
  const details = detailsChoice ?? !summary?.about;
  const lastMessage = useLastMessage(run, details && !chat);
  const long = lastMessage.length > 900;
  return (
    <section className={`card agent tone-border-${runTone(run, summary)}`} id={`r:${run.sessionId}`}>
      <header className="card-head">
        <Dot tone={runTone(run, summary)} pulse={run.status === "working"} />
        <div className="agent-title">
          <h3 title={hideUrls(run.firstPrompt)}>{runTitle(run)}</h3>
          <span className="meta">
            {statusText(run, now, summary)} · {dirLabel(run.cwd)} · {plural(run.userMessageCount, "prompt")}
          </span>
        </div>
        <span className="grow" />
        {ticket && <ThreadButtons ticket={ticket} run={run} onError={onError} />}
        <OpenTab run={run} onError={onError} hotkey={primary} />
      </header>
      <ConversationGist run={run} summary={summary} now={now} open={details} onToggle={() => setDetails(!details)} />
      <LivePanel run={run} now={now} onError={onError} />
      {/* The whole chat ends with the last message, so it replaces it. */}
      {/* A working agent writes its log on every tool call; reload on a new prompt or when it stops, not on each write. */}
      {details && chat && <Chat sessionId={run.sessionId} refreshKey={run.status === "working" ? run.userMessageCount : run.lastActivityAt + run.status} />}
      {details && !chat && lastMessage && (
        <div className={`agent-message ${long && !expanded ? "clamped" : ""}`}>
          <SessionScope sessionId={run.sessionId}>
            <Markdown text={lastMessage} />
          </SessionScope>
          {long && (
            <button className="btn ghost small expand" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Show the whole message"}
            </button>
          )}
        </div>
      )}
      {details && (
        <button className="btn ghost small chat-toggle" aria-expanded={chat} onClick={() => setChat(!chat)}>
          {chat ? "Show only the last message" : "Show the conversation"}
        </button>
      )}
      {run.status !== "finished" && (agentState(run, summary) === "waits_on_review" ? <FoldedComposer run={run} onError={onError} focusSignal={primary ? focusSignal : 0} /> : <Composer run={run} onError={onError} focusSignal={primary ? focusSignal : 0} />)}
    </section>
  );
}

/** The reply box of an agent that waits on review: it asks nothing of you, so the box starts closed. `r` opens it. */
function FoldedComposer({ run, onError, focusSignal }: { run: Run; onError: (m: string | null) => void; focusSignal: number }) {
  const [open, setOpen] = useState(false);
  const seen = useRef(focusSignal);
  useEffect(() => {
    if (focusSignal === seen.current) return;
    seen.current = focusSignal;
    setOpen(true);
  }, [focusSignal]);
  if (open) return <Composer run={run} onError={onError} focusSignal={focusSignal} />;
  return (
    <button className="btn ghost small composer-open" onClick={() => setOpen(true)}>
      Reply to the agent
    </button>
  );
}

function PrRow({ pr, now }: { pr: PullRequest; now: number }) {
  const open = pr.state === "open";
  const review = awaitsOwner(pr) ? [ownerWaitText(pr.approvals), "muted"] : pr.reviewDecision === "APPROVED" ? ["approved", "good"] : pr.reviewDecision === "CHANGES_REQUESTED" ? ["changes requested", "bad"] : pr.reviewDecision === "REVIEW_REQUIRED" ? ["needs review", "muted"] : null;
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

/** An opened row's last message. */
function HistoryMessage({ run }: { run: Run }) {
  const text = useLastMessage(run, true);
  if (!text) return null;
  return (
    <div className="h-message">
      <SessionScope sessionId={run.sessionId}>
        <Markdown text={text} />
      </SessionScope>
    </div>
  );
}

function History({ runs: allRuns, suggested = [], summaries = {}, now, onError, ticket, threads = {}, focus = null }: { runs: Run[]; suggested?: Run[]; summaries?: Record<string, ConversationSummary>; now: number; onError: (m: string | null) => void; ticket?: string; threads?: Record<string, ThreadStatusChange>; focus?: string | null }) {
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
            <span className="h-main">
              <Dot tone={runTone(r, summaries[r.sessionId])} pulse={r.status === "working"} />
              <button className="h-title" onClick={() => setOpen(open === r.sessionId ? null : r.sessionId)} title={hideUrls(r.firstPrompt)}>
                {runTitle(r)}
              </button>
              <span className="meta">
                {shortDate(r.startedAt)} · {dirLabel(r.cwd)} · {plural(r.userMessageCount, "prompt")}
                {r.createdPrs.length > 0 && ` · opened ${plural(r.createdPrs.length, "PR")}`}
              </span>
            </span>
            <span className="meta h-status">{statusText(r, now, summaries[r.sessionId])}</span>
            <span className="h-actions">
              {ticket && <ThreadButtons ticket={ticket} run={r} onError={onError} className="btn ghost small" />}
              <OpenTab run={r} onError={onError} className="btn ghost small" label="Open" />
            </span>
          </div>
          {open !== r.sessionId && r.lastReply && <p className="h-last">{r.lastReply}</p>}
          {open === r.sessionId && <HistoryMessage run={r} />}
        </li>
      ))}
      {ticket &&
        suggested.map((r) => (
          <li key={r.sessionId} id={`h:r:${r.sessionId}`} className="suggested">
            <div className="h-row">
              <span className="h-main">
                <Dot tone="muted" />
                <span className="h-title" title={hideUrls(r.firstPrompt)}>
                  {runTitle(r)}
                </span>
                <span className="meta" title="The thread names the ticket only in its text: no name, branch or PR has the key. It gives no signal until you link it.">
                  {shortDate(r.startedAt)} · mentions {ticket}
                </span>
              </span>
              <span className="h-actions">
                <button className="btn ghost small" onClick={async () => onError(await api.setThread(ticket, r.sessionId, "relevant"))} title={`This thread is about ${ticket}: link it`}>
                  Link
                </button>
                <button className="btn ghost small" onClick={async () => onError(await api.setThread(ticket, r.sessionId, "unlinked"))} title="Hide this suggestion">
                  Hide
                </button>
                <OpenTab run={r} onError={onError} className="btn ghost small" label="Open" />
              </span>
            </div>
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
                <span className="h-main">
                  <span className="resolved-mark" aria-hidden>
                    ✓
                  </span>
                  <span className="h-title" title={hideUrls(r.firstPrompt)}>
                    {runTitle(r)}
                  </span>
                  <span className="meta" title={t.createdAt}>
                    resolved {age(t.createdAt, now)} ago{t.reason ? ` · ${t.reason}` : ""}
                  </span>
                </span>
                <span className="h-actions">
                  <button className="btn ghost small" onClick={async () => onError(await api.setThread(ticket, r.sessionId, "relevant"))} title={`Count this thread for ${ticket} again`}>
                    Mark relevant
                  </button>
                </span>
              </div>
            </li>
          );
        })}
    </ol>
  );
}

/** Pins the ticket to the top of the board and the PRs view. */
function StarButton({ ticket, starred, onError }: { ticket: string; starred: boolean; onError: (m: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    onError(await api.star(ticket, !starred));
    setBusy(false);
  };
  return (
    <button className={`btn ghost star-btn ${starred ? "on" : ""}`} onClick={toggle} disabled={busy} aria-pressed={starred} title={starred ? "Unstar: back to its normal place" : "Star: pin it to the top of the board and the PRs view"}>
      {starred ? "★ Starred" : "☆ Star"}
    </button>
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

/** Scrolls to the agent's card and puts the cursor in its reply box, as R does for the primary run. */
function ReplyButton({ sessionId, label = "Reply" }: { sessionId: string; label?: string }) {
  return (
    <a
      className="btn small"
      href={href(`r:${sessionId}`)}
      onClick={(e) => {
        const card = document.getElementById(`r:${sessionId}`);
        if (!card) return;
        e.preventDefault();
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
      }}
    >
      {label}
    </a>
  );
}

interface WhyRow {
  key: string;
  item: Item;
  finished: boolean;
  smoke: SmoketestRow | null;
  smoketestNeedsYou?: boolean;
  summary?: ConversationSummary;
}

/** The one button of a Needs-you row. It acts on that row's object. */
function WhyAction({ r, ticket, cwd, data, onError }: { r: WhyRow; ticket: TicketGroup["ticket"] | undefined; cwd: string; data: Dashboard; onError: (m: string | null) => void }) {
  const a = r.item;
  if (r.smoke) return r.smoke.action === "reply" && a.sessionId ? <ReplyButton sessionId={a.sessionId} /> : <SmoketestAction row={r.smoke} cwd={cwd} onError={onError} />;
  if (a.kind === "awaiting_input" && a.sessionId) return <ReplyButton sessionId={a.sessionId} />;
  if (a.kind === "run_error" && a.sessionId) return <ReplyButton sessionId={a.sessionId} label="Open" />;
  if (ticket && (a.kind === "overdue" || a.kind === "due_soon")) return <DueDateVerb ticket={ticket} onError={onError} compact />;
  if (a.kind === "stalled") {
    return (
      <a className="btn small" href="#next-steps" onClick={(e) => (e.preventDefault(), document.getElementById("next-steps")?.scrollIntoView({ behavior: "smooth" }))}>
        Next steps
      </a>
    );
  }
  return <PrVerbButton item={a} data={data} />;
}

/** One line of what the row needs, or of what happened. */
function whyLine(r: WhyRow, needs: boolean): string | null {
  if (r.smoke) return r.smoke.detail;
  const ready = readySummary(r.summary);
  if (!ready) return null;
  if (needs) return needsNothing(ready.needs) ? null : ready.needs;
  return ready.latest;
}

/**
 * The ticket header: what needs you, then news, newest first in each, one line a row. A click on
 * a row opens its full summary under it.
 */
function WhyList({ s, parked, data, now, cwd, lastLook, onError }: { s: Subject; parked: ParkedRun[]; data: Dashboard; now: number; cwd: string; lastLook: string | null; onError: (m: string | null) => void }) {
  const t = s.ticket?.ticket;
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    setOpen(null);
    setAll(false);
  }, [s.id]);
  const events = t ? (data.sdlcEvents[t.key] ?? []) : [];
  const rows: WhyRow[] = s.items.map((a, i) => {
    const smoke = t && a.kind === "awaiting_input" ? smoketestRow(a.sessionId, events, { asked: !!a.run?.askedQuestion, finished: a.finished }) : null;
    const agent = a.kind === "awaiting_input" || a.kind === "run_error";
    return {
      // A stable key: the verb button keeps its "Started" state when the list changes order.
      key: `${a.kind}:${a.prUrl ?? a.sessionId ?? a.ticketKey ?? i}`,
      item: a,
      finished: a.finished,
      smoke,
      smoketestNeedsYou: smoke?.needsYou,
      summary: agent && a.sessionId ? data.conversationSummaries[a.sessionId] : undefined,
    };
  });
  const { needs, updates } = groupWhy(rows);
  const shown = all ? updates : updates.slice(0, UPDATES_SHOWN);
  const fresh = (r: WhyRow) => isNewSince(r.item.since, lastLook);
  const newCount = (list: WhyRow[]) => {
    const n = list.filter(fresh).length;
    return n ? <span className="why-new-count"> · {n} new</span> : null;
  };

  const row = (r: WhyRow, need: boolean) => {
    const a = r.item;
    const line = whyLine(r, need);
    const isOpen = open === r.key;
    const date = a.kind === "overdue" || a.kind === "due_soon";
    const detail = r.smoke ? [r.smoke.detail, a.gist].filter(Boolean).join("\n") : (a.gist ?? a.reason);
    const isNew = fresh(r);
    return (
      <li
        key={r.key}
        className={`why-row ${need ? "" : "update"} ${isOpen ? "open" : ""} ${isNew ? "new" : ""}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a, button, input, select, textarea") || window.getSelection()?.toString()) return;
          setOpen(isOpen ? null : r.key);
        }}
        title={isOpen ? undefined : "Show the full summary"}
      >
        <div className="why-line">
          {r.smoke ? (
            <span className="row-head">
              <span className="tag type-chip">Smoketest</span>
              <span className={`tag tone-${r.smoke.tone}`}>{r.smoke.status}</span>
              <SmoketestName row={r.smoke} />
            </span>
          ) : (
            <RowHead a={a} summary={r.summary} pageTicket={t?.key} status={statusWord(a.status)} />
          )}
          {line && <span className="why-need">{line}</span>}
          <span className="grow" />
          {isNew && (
            <span className="tag why-new" title={lastLook ? `Since you last looked, ${stamp(lastLook)}` : "You have not looked at this ticket before"}>
              new
            </span>
          )}
          {!date && <span className="meta why-age" title={stamp(a.since)}>{age(a.since, now)}</span>}
          {need ? <WhyAction r={r} ticket={t} cwd={cwd} data={data} onError={onError} /> : <PrVerbButton item={a} data={data} />}
        </div>
        {isOpen && <div className="why-detail">{detail}</div>}
      </li>
    );
  };

  return (
    <div className="why">
      {needs.length > 0 && (
        <>
          <div className="why-group">
            Needs you · {needs.length}
            {newCount(needs)}
          </div>
          <ul className="why-rows">{needs.map((r) => row(r, true))}</ul>
        </>
      )}
      {parked.length > 0 && (
        <>
          <div className="why-group">Parked asks · {parked.length}</div>
          <ParkedAskList rows={parked} now={now} onError={onError} />
        </>
      )}
      {updates.length > 0 && (
        <>
          <div className="why-group">
            Updates · {updates.length}
            {newCount(updates)}
          </div>
          <ul className="why-rows">{shown.map((r) => row(r, false))}</ul>
          {updates.length > shown.length && (
            <button className="btn ghost small why-more" onClick={() => setAll(true)}>
              Show {updates.length - shown.length} more
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Workspace({ s, parked, data, now, position, doneForNow, onDoneForNow, onWake, onSnoozed, focusSignal, noteSignal, agentSignal, snoozeSignal, anchor, lastLook }: {
  s: Subject;
  /** The ticket's parked asks that could need you. */
  parked: ParkedRun[];
  /** Your look at this entry before this one: what came after it is marked new. */
  lastLook: string | null;
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
  const suggested = s.ticket?.suggested ?? [];
  // A ticket's documents, or a run's when the entry is a run with no ticket.
  const documents = data.documents.filter((d) => (s.ticket ? d.ticket === s.ticket.ticket.key : d.sessionId === s.run?.sessionId));
  const top = lead(s);

  return (
    <article className="workspace" key={s.id}>
      <header className="ws-head">
        <div className="eyebrow">
          {isDone(s) && (
            <>
              <Dot tone="good" />
              <span className="tone-text-good">Done in {s.ticket!.ticket.source.label}</span>
            </>
          )}
          {top && isDone(s) ? (
            <span className={`tag tone-${look(top).tone}`}>{look(top).short}</span>
          ) : top ? (
            <>
              <Dot tone={look(top).tone} />
              <span className={`tone-text-${look(top).tone}`}>{look(top).title}</span>
              <OtherTags s={s} />
            </>
          ) : isDone(s) ? null : (
            <span>{live.length ? "Agents at work" : "Quiet"}</span>
          )}
          {position && <span className="meta">· {position}</span>}
        </div>
        <h1>{subjectTitle(s)}</h1>
        <div className="ws-meta">
          {t && (
            <a className="key-link" href={t.url} target="_blank" rel="noreferrer" title={t.file ? "Open the ticket file" : `Open in ${t.source.label}`}>
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
          {t && !documents.some((d) => d.type === "ticket-summary") && <WriteTicketSummary key={`summary-${t.key}`} ticket={t.key} cwd={cwd} onError={setError} />}
          {t && <StarButton key={`star-${t.key}`} ticket={t.key} starred={data.starred.includes(t.key)} onError={setError} />}
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
          <ViewToolsSlot />
        </div>
        {s.ticket && <SdlcBar group={s.ticket} events={data.sdlcEvents[s.ticket.ticket.key] ?? []} cwd={cwd} onError={setError} />}
        {s.items.length + parked.length > 0 && <WhyList s={s} parked={parked} data={data} now={now} cwd={cwd} lastLook={lastLook} onError={setError} />}
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

      {featured.length > 0 && (
        <div className="stack">
          <h2 className="section-title">{live.length ? (live.length === 1 ? "Agent" : `Agents · ${live.length}`) : "Last run"}</h2>
          {featured.map((r) => (
            <AgentCard key={r.sessionId} run={r} now={now} onError={setError} focusSignal={focusSignal} primary={r.sessionId === primary?.sessionId} ticket={s.ticket?.ticket.key} summary={data.conversationSummaries[r.sessionId]} />
          ))}
        </div>
      )}

      {s.ticket && (data.lanes[s.ticket.ticket.key]?.length ?? 0) > 0 && <LanesCard ticket={s.ticket.ticket.key} title={s.ticket.ticket.summary} lanes={data.lanes[s.ticket.ticket.key]} prs={prs} runFor={(id) => laneRun(s, id, now, data.conversationSummaries[id])} onError={setError} />}

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

      {s.ticket && <Smoketests group={s.ticket} events={data.sdlcEvents[s.ticket.ticket.key] ?? []} now={now} cwd={cwd} onError={setError} />}

      {s.ticket && <TicketSummaryDoc key={`summary-${s.id}`} ticket={s.ticket.ticket.key} documents={documents} runs={runs} cwd={cwd} now={now} onError={setError} />}

      {t && <TicketPanel key={t.key} ticket={t} onError={setError} />}

      {s.ticket && <StartAgent key={s.id} s={s} cwd={cwd} setCwd={setCwd} onError={setError} focusSignal={agentSignal} />}

      {s.ticket && <Notes ticket={s.ticket.ticket.key} notes={data.notes[s.ticket.ticket.key] ?? []} now={now} onError={setError} focusSignal={noteSignal} />}

      {(s.ticket || documents.length > 0) && <Documentation key={`docs-${s.id}`} documents={documents} runs={runs} cwd={cwd} now={now} onError={setError} />}

      {runs.length + suggested.length > 0 && (
        <div className="stack">
          <h2 className="section-title">
            History · {plural(runs.length, "run")}
            {suggested.length > 0 && ` · ${plural(suggested.length, "mention")}`}
          </h2>
          <div className="card flush">
            <History runs={runs} suggested={suggested} summaries={data.conversationSummaries} now={now} onError={setError} ticket={s.ticket?.ticket.key} threads={s.ticket?.threads} focus={anchor} />
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
  useReviewDrafts(data.prs, data.reviewDrafts);
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
                  <a className="key-link" href={t.url} target="_blank" rel="noreferrer" title={t.file ? "Open the ticket file" : `Open in ${t.source.label}`}>
                    {t.key} ↗
                  </a>
                  {data.starred.includes(t.key) && (
                    <span className="star-mark" title="Starred" aria-label="Starred">
                      ★
                    </span>
                  )}
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
                    {wantsReviewRequest(pr) && <ReviewRequest pr={pr} draft={data.reviewDrafts[pr.url]} sent={data.reviewRequests[pr.url]} now={now} />}
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

// ---- queue entry: the next step ------------------------------------------------------

/** The first step of the ticket's newest finished next-steps draft. */
function firstStep(data: Dashboard, s: Subject): NextStep | null {
  const state = s.ticket ? data.summaries[s.ticket.ticket.key] : undefined;
  const shown = state?.latest.status === "done" ? state.latest : state?.lastDone;
  return shown?.steps[0] ?? null;
}

/** What the lead agent needs from you, from its summary: the "Needs from you" line of a queue entry. */
function needLine(s: Subject, data: Dashboard): string | null {
  const a = lead(s);
  if (!a || a.info || !a.sessionId || (a.kind !== "awaiting_input" && a.kind !== "run_error")) return null;
  const ready = readySummary(data.conversationSummaries[a.sessionId]);
  return ready && !needsNothing(ready.needs) ? ready.needs : null;
}

/** The queue entry's one next step: the place in agent-dash where you act on its lead signal. */
function NextStepLink({ s, data }: { s: Subject; data: Dashboard }) {
  const a = lead(s);
  if (!a) return null;
  const next = needStep(a, firstStep(data, s), s.id);
  return (
    <a className="btn small" href={href(next.ref)}>
      {next.label} →
    </a>
  );
}

// ---- History view -------------------------------------------------------------------

/** Rows rendered at first. A year of chats is about a thousand rows, which is slow to render at once. */
const HISTORY_PAGE = 150;
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
            <ol className="history chats">
              {g.runs.map((r) => (
                <li key={r.sessionId} className={open === r.sessionId ? "open" : ""}>
                  <div className="h-row">
                    <span className="h-main">
                      <Dot tone={runTone(r, data.conversationSummaries[r.sessionId])} pulse={r.status === "working"} />
                      <button className="h-title" onClick={() => setOpen(open === r.sessionId ? null : r.sessionId)} title={hideUrls(r.firstPrompt)}>
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
                      <span className="meta">
                        {dirLabel(r.cwd)} · {plural(r.userMessageCount, "prompt")} · started {stamp(r.startedAt)}
                      </span>
                    </span>
                    <span className="meta h-status">{statusText(r, now, data.conversationSummaries[r.sessionId])}</span>
                    <span className="h-actions">
                      <OpenTab run={r} onError={setActionError} className="btn ghost small" label="Open" />
                    </span>
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

const NOTIFY_HINT = "One notification per ticket: it comes when an agent on the ticket stops, or when something new on it needs you, and later updates join it until you look at the ticket. It needs this page open in a tab.";

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
        <span className="meta">A plain {agentLabel()} with no ticket context. It runs without a terminal, and you talk to it on this page.</span>
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
  // A document can link to a conversation older than the board's window.
  const old = useLoad(() => (run ? Promise.resolve(null) : api.transcript(sessionId)), run ? "live" : `${sessionId} ${data.generatedAt}`);
  const documents = data.documents.filter((d) => d.sessionId === sessionId);
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
              <Dot tone={runTone(run, data.conversationSummaries[sessionId])} pulse={run.status === "working"} />
              <span className="meta">
                {statusText(run, now, data.conversationSummaries[sessionId])} · {dirLabel(run.cwd)} · {plural(run.userMessageCount, "prompt")}
              </span>
              {run.headless ? (
                <button className="btn ghost small" title={`Stop this ${agentLabel()} process. Resume here continues it later.`} onClick={async () => setError(await api.endConversation(sessionId))}>
                  End conversation
                </button>
              ) : (
                <OpenTab run={run} onError={setError} className="btn ghost small" />
              )}
            </>
          ) : old.value ? (
            <span className="meta">An older conversation, from its log</span>
          ) : (
            <span className="meta">Starting {agentLabel()}…</span>
          )}
        </div>
      </header>
      {error && <div className="toast">{error}</div>}
      {/* The run shows once pi saved the first message; until then there is no chat to load. */}
      {documents.length > 0 && <Documentation documents={documents} runs={run ? [run] : []} cwd={run?.cwd ?? "~"} now={now} onError={setError} />}
      {run && <ConversationGist run={run} summary={data.conversationSummaries[sessionId]} now={now} />}
      {run && <Chat sessionId={sessionId} refreshKey={run.lastActivityAt + run.status} />}
      {!run && old.value && <Chat sessionId={sessionId} refreshKey="old" />}
      {run && <LivePanel run={run} now={now} onError={setError} working="The agent is working…" />}
      {run && run.status !== "finished" && <Composer run={run} onError={setError} focusSignal={0} />}
      {run?.status === "finished" && <p className="meta">{resuming(sessionId) ? `Starting ${agentLabel()}…` : "This conversation ended. Resume here (at the top) continues it on this page, and Copy resume in a terminal."}</p>}
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
  ["C", "Start a new conversation with the agent on its own page, with no context"],
  ["V", "Switch the board between the queue and the kanban"],
  ["F", "Show the ticket view across the full window, or leave full screen"],
  ["↵", "On the kanban: open the selected card's workspace"],
  ["/", "On the kanban: search the cards (ticket keys rank first)"],
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
        <h4>Advanced</h4>
        <a href="#/help/local-url" onClick={onClose}>
          Open agent-dash at your own URL
        </a>
      </div>
    </div>
  );
}

// ---- help: your own URL --------------------------------------------------------------

function Commands({ text, label }: { text: string; label: string }) {
  return (
    <div className="lu-code">
      <CopyButton text={text} label={label} className="btn ghost small" />
      <pre>{text}</pre>
    </div>
  );
}

function LocalUrlView() {
  const [hostText, setHostText] = useState("agent-dash.test");
  const [portText, setPortText] = useState("7777");
  const host = cleanHost(hostText);
  const port = cleanPort(portText);
  return (
    <article className="workspace local-url">
      <header className="ws-head">
        <h1>Open agent-dash at your own URL</h1>
        <div className="ws-meta">
          <span className="meta">
            agent-dash listens on <code>http://127.0.0.1:{port ?? 7777}</code>. These steps give it a name with HTTPS, such as <code>https://agent-dash.test</code>. The name works on your Mac only: nothing goes to public DNS, and no other computer can open it. You need macOS, Homebrew, and an admin password.
          </span>
        </div>
      </header>

      <section className="card">
        <label className="lu-field">
          <span className="setting-label">Your URL</span>
          <input value={hostText} onChange={(e) => setHostText(e.target.value)} spellCheck={false} aria-invalid={!host} />
        </label>
        <label className="lu-field">
          <span className="setting-label">agent-dash port</span>
          <input value={portText} onChange={(e) => setPortText(e.target.value)} spellCheck={false} aria-invalid={!port} />
        </label>
        <p className="meta">
          {host ? (
            <>
              Use a name that ends in <code>.test</code>, or a name on a domain that you own. <code>.test</code> is reserved, so it can never be a real site. The port is 7777 unless you set <code>AGENT_DASH_PORT</code>.
            </>
          ) : (
            "Type a host name only, such as agent-dash.test: letters, digits, dots and dashes, with no path."
          )}
        </p>
      </section>

      {host && port && (
        <>
          <h3 className="section-title">How it works</h3>
          <p>
            <code>/etc/hosts</code> sends <code>{host}</code> to 127.0.0.1. pf, the macOS firewall, sends ports 443 and 80 to Caddy on {CADDY_HTTPS} and {CADDY_HTTP}. Caddy makes a certificate from its own local CA and sends each request to agent-dash. Caddy runs as you, so only step 2 needs sudo.
          </p>

          <h3 className="section-title">1. Start Caddy (no sudo)</h3>
          <p className="meta">
            This adds the site to Homebrew's Caddyfile. If that file already has a global options block (a <code>{"{ }"}</code> block with no name), put the four options in it, because Caddy accepts only one, at the top.
          </p>
          <Commands text={caddyCommands(host, port)} label="Copy" />

          <h3 className="section-title">2. Point the name and the ports at Caddy (sudo)</h3>
          <p className="meta">
            Save this as <code>local-url.sh</code>, then run <code>sudo sh local-url.sh</code>. It adds the name to <code>/etc/hosts</code>, loads the pf redirect now and at each boot, and adds Caddy's CA to the System keychain. You can run it again.
          </p>
          <Commands text={rootScript(host)} label="Copy" />

          <h3 className="section-title">3. Open it</h3>
          <p>
            Open <a href={`https://${host}`}>https://{host}</a>. agent-dash must be running: if it is not, Caddy shows a 502.
          </p>

          <h3 className="section-title">Good to know</h3>
          <ul className="lu-notes">
            <li>Every request to 127.0.0.1 on port 80 or 443 now goes to Caddy. If another local server uses those ports, move it, or give it its own site in the Caddyfile.</li>
            <li>To add a second name, add its two site blocks to the Caddyfile, add the name to <code>/etc/hosts</code>, and run <code>brew services restart caddy</code>. pf needs no change.</li>
            <li>Firefox has its own certificate store and does not trust Caddy's CA. Chrome and Safari use the macOS keychain.</li>
            <li>
              To check it: <code>curl -sI https://{host}</code> gives 200, and <code>sudo pfctl -a com.apple/250.local-url -s nat</code> shows the two rules. Caddy's log is <code>$(brew --prefix)/var/log/caddy.log</code>.
            </li>
          </ul>

          <h3 className="section-title">Undo</h3>
          <Commands text={undoCommands(host)} label="Copy" />
        </>
      )}
    </article>
  );
}

// ---- page ---------------------------------------------------------------------------

export function App() {
  const { data, error, loading, refresh } = useDashboard();
  const focused = usePageFocus();
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
  const viewWidth = useViewWidth();
  const mainRef = useRef<HTMLElement>(null);
  const kanbanRef = useRef<HTMLDivElement>(null);
  // On the kanban, the workspace opens in a drawer over the columns when you pick a card.
  const [drawer, setDrawer] = useState(() => route.view === "board" && !!route.ref);
  const [kanbanQuery, setKanbanQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const subjects = useMemo(() => (data ? buildSubjects(data) : new Map<string, Subject>()), [data]);
  const until = (s: Subject) => (s.ticket ? data?.snoozedUntil[s.ticket.ticket.key] : undefined);
  const ticketSnoozed = (s: Subject) => isSnoozed(until(s), now);
  // A snoozed ticket leaves every other section until its time comes, whatever its signals say.
  const snoozedList = [...subjects.values()].filter(ticketSnoozed).sort((a, b) => until(a)!.localeCompare(until(b)!));
  const all = [...subjects.values()].filter((s) => !ticketSnoozed(s));
  const starredKeys = useMemo(() => new Set(data?.starred ?? []), [data]);
  const isStarred = (s: Subject) => !!s.ticket && starredKeys.has(s.ticket.ticket.key);
  const ranked = all.filter(actionable).sort((a, b) => lead(b)!.score - lead(a)!.score);
  // Starred entries lead the queue, so their ranks are the first ones.
  const queue = starredFirst(ranked.filter((s) => !doneForNow.isDone(s)), isStarred);
  const done = ranked.filter((s) => doneForNow.isDone(s));
  // Only context left, such as a PR out for review: the ball is with someone else.
  const othersTurn = all.filter((s) => s.items.length && !actionable(s) && !isDone(s) && !onlyFinished(s)).sort((a, b) => lead(b)!.score - lead(a)!.score);
  const finishedList = all.filter((s) => !actionable(s) && !isDone(s) && onlyFinished(s)).sort((a, b) => lead(b)!.score - lead(a)!.score);
  const working = all.filter((s) => !s.items.length && liveRuns(s).length && !isDone(s));
  // Closed in its tracker, but agents still open on it: worth a glance to close the tabs, never a task.
  const doneTickets = all.filter((s) => isDone(s) && (s.items.length || liveRuns(s).length));
  const quiet = data ? data.myTickets.map((g) => subjects.get(`t:${g.ticket.key}`)!).filter((s) => !ticketSnoozed(s) && !s.items.length && !liveRuns(s).length) : [];
  // A starred ticket shows once, in the Starred section at the top of the rail; a snooze still hides it.
  const unsnoozed = [...queue, ...othersTurn, ...working, ...finishedList, ...done, ...doneTickets, ...quiet];
  const starredList = unsnoozed.filter(isStarred);
  const unstarred = (list: Subject[]) => list.filter((s) => !isStarred(s));
  const order = [...starredList, ...unstarred(unsnoozed), ...snoozedList];
  // The search keeps only the matching cards, best match first, and J/K walk them in that order.
  const kanbanOrder = boardMode === "kanban" && data ? searchCards(order, kanbanQuery, (s) => searchFields(s, data)) : order;

  // The parked asks that could need you: each one shows in its ticket's "why" list when the ticket is in Up next, else under Parked asks.
  const parkedNeeds = useMemo(() => (data ? splitParked(data).needsYou : []), [data]);
  const queueTickets = new Set(queue.flatMap((s) => (s.ticket ? [s.ticket.ticket.key] : [])));
  const snoozedTickets = new Set(Object.entries(data?.snoozedUntil ?? {}).flatMap(([k, u]) => (isSnoozed(u, now) ? [k] : [])));
  const asks = parkedAsks(parkedNeeds, queueTickets, snoozedTickets);
  // The one count of work: the top bar, the tab title, and the board agree on it.
  const needsYou = needsYouCount(queue.length, asks);
  const askSel = askKey(boardRef);
  const asksOf = (key: string) => parkedNeeds.filter((p) => p.ticket === key);

  const target = data && boardRef && askSel === undefined ? resolveBoardRef(boardRef, data, new Set(subjects.keys())) : null;
  // A Parked asks group shows its own pane, so no entry is selected.
  const selected = askSel !== undefined ? null : (target && subjects.get(target.subjectId)) || queue[0] || order[0] || null;
  // You look at an entry while its workspace shows in a focused tab. On the kanban, that is the drawer.
  const looking = focused && view === "board" && (boardMode === "queue" || drawer) && selected ? selected.id : null;
  const look = useLook(looking);
  const notify = useWaitNotifications(data, looking);

  useEffect(() => {
    const onHash = () => {
      const to = redirectHash(location.hash);
      if (to) history.replaceState(null, "", to);
      const next = parseHash(location.hash);
      setRoute(next);
      if (next.view === "board") {
        setBoardRef(next.ref);
        if (next.ref) setDrawer(true);
      }
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = useCallback((id: string) => {
    setBoardRef(id);
    history.replaceState(null, "", href(id));
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (!kanbanOrder.length) return;
      const i = selected ? kanbanOrder.findIndex((s) => s.id === selected.id) : -1;
      select(kanbanOrder[Math.max(0, Math.min(kanbanOrder.length - 1, i + delta))].id);
    },
    [kanbanOrder, selected, select],
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
      if ((view === "prs" || view === "history" || view === "wiki") && rowKey(e.key)) return void e.preventDefault();
      if (view !== "board" && e.key !== "?" && e.key !== "Escape") return;
      if (e.key === "j" || e.key === "ArrowDown") move(1);
      else if (e.key === "k" || e.key === "ArrowUp") move(-1);
      else if (e.key === "e") doneAndAdvance();
      else if (e.key === "z" && selected?.ticket) setSnoozeSignal((n) => n + 1);
      else if (e.key === "?") setHelp((h) => !h);
      else if (e.key === "Escape") {
        if (help) setHelp(false);
        else if (viewWidth.full) viewWidth.setFull(false);
        else setDrawer(false);
      } else if (e.key === "f" && (boardMode === "queue" || drawer)) viewWidth.setFull(!viewWidth.full);
      else if (e.key === "v") setBoardMode(boardMode === "queue" ? "kanban" : "queue");
      else if (e.key === "Enter" && boardMode === "kanban" && !drawer && selected) setDrawer(true);
      else if (e.key === "/" && boardMode === "kanban") searchRef.current?.focus();
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
  }, [move, doneAndAdvance, selected, data, view, help, boardMode, setBoardMode, drawer, viewWidth]);

  const openTitle = view === "board" && (boardMode === "queue" || drawer) && selected ? subjectTitle(selected) : null;
  useEffect(() => {
    document.title = tabTitle({ route, data, needsYou, open: openTitle });
  }, [route, data, needsYou, openTitle]);

  if (!data) return <main className="loading">{error ? <pre className="error">{error}</pre> : <span className="shimmer wide" />}</main>;

  const waitingRuns = waitingOnYou(data.counts.awaiting_input, runsOf(data), data.conversationSummaries);
  const workingRuns = data.counts.working;
  const position = selected && queue.includes(selected) ? `${queue.indexOf(selected) + 1} of ${queue.length} in the queue` : null;
  const sources = Object.entries(data.sources);
  const down = sources.filter(([, h]) => !h.ok);
  const openPrs = data.prs.filter((p) => p.state === "open").length;

  const workspace = (
    <>
      {!data.extensionInstalled && (
        <p className="banner">
          {data.team?.agent === "claude" ? (
            <>
              Run <code>pnpm install-extension</code> to get exact statuses from Claude Code sessions that agent-dash did not start.
            </>
          ) : (
            <>
              Run <code>pnpm install-extension</code> to get exact statuses and replies from here.
            </>
          )}
        </p>
      )}
      {boardRef && !target && askSel === undefined && (
        <p className="banner">
          <code>{boardRef}</code> is not on the board. It may be older than 14 days, or closed: look for it in <a href="#/history">History</a>.
        </p>
      )}
      {askSel !== undefined ? (
        <ParkedAsksPane ticketKey={askSel} rows={askSel ? asksOf(askSel) : asks.groups.find((g) => !g.key)?.rows ?? []} data={data} onBoard={!!askSel && subjects.has(`t:${askSel}`)} now={now} />
      ) : selected ? (
        <Workspace
          parked={selected.ticket ? asksOf(selected.ticket.ticket.key) : []}
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
          lastLook={look?.id === selected.id ? look.lastLook : lastSeen(selected.id)}
        />
      ) : (
        <div className="zero big">Nothing to show.</div>
      )}
    </>
  );
  const newConversation = (
    <a className="btn" href="#/c" title={`Start a plain ${agentLabel()} with no ticket context, and talk to it on its own page`}>
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
              Board
            </a>
            <a href="#/prs" className={view === "prs" ? "active" : ""} aria-current={view === "prs" ? "page" : undefined}>
              PRs {openPrs > 0 && <span className="count">{openPrs}</span>}
            </a>
            <a href="#/history" className={view === "history" ? "active" : ""} aria-current={view === "history" ? "page" : undefined}>
              History
            </a>
            <a href="#/documents" className={view === "documents" || view === "document" || view === "diagram" ? "active" : ""} aria-current={view === "documents" ? "page" : undefined}>
              Documents {data.documents.length > 0 && <span className="count">{data.documents.length}</span>}
            </a>
            <a href="#/wiki" className={view === "wiki" ? "active" : ""} aria-current={view === "wiki" ? "page" : undefined}>
              Wiki
            </a>
            <a href="#/worktrees" className={view === "worktrees" ? "active" : ""} aria-current={view === "worktrees" ? "page" : undefined}>
              Worktrees
            </a>
            <a href="#/settings" className={view === "settings" ? "active" : ""} aria-current={view === "settings" ? "page" : undefined}>
              Settings
            </a>
          </nav>
        </div>
        <div className="headline">
          <a href="#/" className="needs-link" onClick={() => setBoardMode("queue")} title={`${queue.length} in Up next, and ${asks.entries} under Parked asks. A ticket counts one time.`}>
            <b>{needsYou ? `Needs you ${needsYou}` : "Nothing needs you"}</b>
          </a>
          <span className="sep">·</span>
          <span className="live-status" title="Live agents now: a status, not a count of work">
            <span>
              <Dot tone="waiting" /> {waitingRuns} waiting
            </span>
            <span>
              <Dot tone="working" pulse={workingRuns > 0} /> {workingRuns} working
            </span>
          </span>
        </div>
        <span className="grow" />
        <span className={`sources ${down.length ? "bad" : ""}`} title={sources.map(([n, h]) => `${h.label ?? n}: ${h.off ? "off (not set up)" : h.ok ? "ok" : h.error}`).join("\n")}>
          {down.length ? `${down.map(([n, h]) => h.label ?? n).join(", ")} down` : [...sources.filter(([n]) => n !== "sessions").map(([n, h]) => `${h.label ?? n}${h.off ? " off" : ""}`), agentLabel()].join(" · ")}
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
      {route.view !== "settings" && <SetupBanner setup={data.setup ?? []} />}

      {route.view === "parked" ? (
        <main className="main">
          <ParkedView data={data} now={now} />
        </main>
      ) : route.view === "prs" ? (
        <main className="main">
          {route.pr ? <PrPanel key={route.pr} refId={route.pr} data={data} now={now} /> : <PrsView data={data} now={now} />}
        </main>
      ) : view === "history" ? (
        <main className="main">
          <HistoryView data={data} now={now} />
        </main>
      ) : route.view === "documents" ? (
        <main className="main">
          <DocumentsView data={data} now={now} />
        </main>
      ) : route.view === "wiki" ? (
        <main className="main">
          {route.ref ? <WikiNoteView key={route.ref} refId={route.ref} /> : <WikiListView />}
        </main>
      ) : route.view === "worktrees" ? (
        <main className="main">
          <WorktreesView now={now} />
        </main>
      ) : route.view === "settings" ? (
        <main className="main">
          <SettingsView />
        </main>
      ) : route.view === "localUrl" ? (
        <main className="main">
          <LocalUrlView />
        </main>
      ) : route.view === "document" ? (
        <main className="main">
          <DocumentView key={route.id} id={route.id} data={data} now={now} />
        </main>
      ) : route.view === "diagram" ? (
        <main className="main">
          <DocumentView key={`d${route.id}`} diagramId={route.id} data={data} now={now} />
        </main>
      ) : route.view === "conversation" ? (
        <main className="main">
          {route.id ? <ConversationView key={route.id} sessionId={route.id} data={data} now={now} /> : <NewConversationForm />}
        </main>
      ) : boardMode === "kanban" ? (
        <div className="kanban-view" ref={kanbanRef}>
          <div className="kanban-bar">
            {newConversation}
            <BoardModeToggle mode={boardMode} setMode={setBoardMode} />
            <input
              ref={searchRef}
              className="search kanban-search"
              type="search"
              placeholder="Search keys and text (/)"
              aria-label="Search the cards"
              value={kanbanQuery}
              onChange={(e) => setKanbanQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setKanbanQuery("");
                  e.currentTarget.blur();
                } else if (e.key === "Enter" && kanbanOrder[0]) {
                  select(kanbanOrder[0].id);
                  setDrawer(true);
                  e.currentTarget.blur();
                }
              }}
            />
            <span className="meta">{kanbanQuery.trim() ? `${kanbanOrder.length} ${kanbanOrder.length === 1 ? "match" : "matches"}, best first. ↵ opens the first.` : "Each card sits in the column of the furthest SDLC stage that its ticket reached."}</span>
          </div>
          <KanbanBoard
            order={kanbanOrder}
            dim={new Set([...done, ...finishedList, ...quiet, ...snoozedList])}
            ranks={new Map(queue.map((s, i) => [s, i + 1]))}
            selected={selected}
            onSelect={(s) => {
              select(s.id);
              setDrawer(true);
            }}
            data={data}
            now={now}
            until={until}
            isStarred={isStarred}
          />
          {drawer && selected && (
            <aside className={`kanban-drawer ${viewWidth.full ? "full" : ""}`} aria-label="Workspace" style={viewWidth.full ? undefined : { width: `min(${viewWidth.width}px, 100%)` }}>
              {!viewWidth.full && <ResizeHandle side="left" scale={1} view={viewWidth} max={() => kanbanRef.current?.clientWidth ?? window.innerWidth} />}
              <div className="drawer-scroll">
                <ViewTools.Provider
                  value={
                    <>
                      <FullScreenButton view={viewWidth} />
                      <button className="btn ghost small" onClick={() => setDrawer(false)} title="Close the workspace (Esc)">
                        Close <Kbd>Esc</Kbd>
                      </button>
                    </>
                  }
                >
                  {workspace}
                </ViewTools.Provider>
              </div>
            </aside>
          )}
        </div>
      ) : (
        <div className={`columns ${viewWidth.full ? "full" : ""}`}>
          <nav className="rail">
            <div className="new-conversation">
              {newConversation}
              <BoardModeToggle mode={boardMode} setMode={setBoardMode} />
            </div>
            <RailSection title="Starred" count={starredList.length} hint="Tickets you starred, pinned to the top">
              {starredList.map((s) => (
                <QueueItem key={s.id} s={s} starred rank={queue.includes(s) ? queue.indexOf(s) + 1 : undefined} need={queue.includes(s) ? needLine(s, data) : null} footer={queue.includes(s) ? <NextStepLink s={s} data={data} /> : undefined} dim={done.includes(s) || finishedList.includes(s) || quiet.includes(s)} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} summary={s.ticket ? data.summaries[s.ticket.ticket.key] : undefined} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <RailSection title="Up next" count={unstarred(queue).length}>
              {unstarred(queue).map((s) => (
                <QueueItem key={s.id} s={s} rank={queue.indexOf(s) + 1} need={needLine(s, data)} footer={<NextStepLink s={s} data={data} />} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} summary={s.ticket ? data.summaries[s.ticket.ticket.key] : undefined} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <RailSection title="Parked asks" count={asks.entries} hint="Agents that agent-dash parked with an ask of their own, on an open ticket. A ticket in Up next shows its asks in its own why list.">
              {asks.groups.map((g) => (
                <AskItem key={askRef(g.key)} g={g} title={g.key ? (subjects.get(`t:${g.key}`)?.ticket?.ticket.summary ?? g.key) : "Conversations with no ticket"} selected={boardRef === askRef(g.key)} onSelect={() => select(askRef(g.key))} now={now} />
              ))}
            </RailSection>
            {data.parked.length > 0 && (
              <a className="rail-link" href="#/parked" title="Every parked agent, also the ones that need nothing from you">
                All {plural(data.parked.length, "parked agent")} →
              </a>
            )}
            {needsYou === 0 && (
              <div className="zero">
                <div className="zero-mark">✓</div>
                <p>
                  <b>Queue clear.</b>
                  <br />
                  {workingRuns ? `${plural(workingRuns, "agent")} still working.` : "No agent is working."}
                </p>
              </div>
            )}
            <RailSection title="Waiting on others" count={unstarred(othersTurn).length} hint="Someone else has the next move, such as a reviewer">
              {unstarred(othersTurn).map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <RailSection title="Agents at work" count={unstarred(working).length} hint="Live runs that need nothing from you yet">
              {unstarred(working).map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <RailSection title="Agents finished" count={unstarred(finishedList).length} hint="Agents that stopped and need nothing from you">
              {unstarred(finishedList).map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <RailSection title="Done for now" count={unstarred(done).length} defaultOpen={false} hint="Back in the queue when something changes">
              {unstarred(done).map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <RailSection title="Snoozed" count={snoozedList.length} defaultOpen={false} hint="Back on the board at the time you picked">
              {snoozedList.map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} snoozedUntil={until(s)} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <RailSection title="Done tickets" count={unstarred(doneTickets).length} defaultOpen={false} hint="Closed tickets that still have agents open">
              {unstarred(doneTickets).map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} />
              ))}
            </RailSection>
            <RailSection title="Quiet tickets" count={unstarred(quiet).length} defaultOpen={false} hint="Your tickets with nothing going on">
              {unstarred(quiet).map((s) => (
                <QueueItem key={s.id} s={s} selected={s.id === selected?.id} onSelect={() => select(s.id)} now={now} notes={s.ticket ? (data.notes[s.ticket.ticket.key]?.length ?? 0) : 0} />
              ))}
            </RailSection>
            <footer className="rail-foot">
              <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>E</Kbd> done · <Kbd>R</Kbd> reply · <Kbd>N</Kbd> note · <Kbd>?</Kbd> more
            </footer>
          </nav>

          <main className="main" ref={mainRef}>
            <div className="ws-frame" style={viewWidth.full ? undefined : { maxWidth: viewWidth.width }}>
              {!viewWidth.full && <ResizeHandle side="left" scale={2} view={viewWidth} max={() => mainRef.current?.clientWidth ?? window.innerWidth} />}
              {!viewWidth.full && <ResizeHandle side="right" scale={2} view={viewWidth} max={() => mainRef.current?.clientWidth ?? window.innerWidth} />}
              <ViewTools.Provider value={<FullScreenButton view={viewWidth} />}>{workspace}</ViewTools.Provider>
            </div>
          </main>
        </div>
      )}
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}
