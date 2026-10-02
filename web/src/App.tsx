import { useCallback, useEffect, useState } from "react";
import type { AttentionItem, Dashboard, PullRequest, Run, SourceHealth, TicketGroup, TicketSummaryState } from "../../shared/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RUNS_SHOWN = 5;

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.round(ms / MIN)}m ago`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h ago`;
  return `${Math.round(ms / DAY)}d ago`;
}

/** "45s ago", "12m ago", "3h ago", "4d ago", "2w ago". */
function sinceLabel(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 14 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return `${Math.floor(s / (7 * 86_400))}w ago`;
}

/** Re-render on a timer, so relative times stay true between data updates. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function prName(url: string): string {
  const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : url;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The project folder name, or ~ for a session started in the home folder. */
function dirLabel(cwd: string): string {
  if (/^\/Users\/[^/]+\/?$/.test(cwd)) return "~";
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

function resumeCommand(run: Run): string {
  return `cd '${run.cwd.replace(/'/g, "'\\''")}' && pi --session ${run.sessionId}`;
}

function useDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard${refresh ? "?refresh" : ""}`);
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const events = new EventSource("/api/events");
    events.addEventListener("change", () => load());
    return () => events.close();
  }, [load]);

  return { data, error, loading, refresh: () => load(true) };
}

// ---- small pieces -------------------------------------------------------------------

const STATUS_LABEL: Record<Run["status"], string> = { working: "working", awaiting_input: "awaiting input", finished: "finished" };

function StatusPill({ run }: { run: Run }) {
  const guess = run.statusSource === "heuristic" && run.status !== "finished";
  return (
    <span className={`pill status-${run.status}`} title={guess ? "Guessed from the session log" : undefined}>
      {STATUS_LABEL[run.status]}
      {guess ? "?" : ""}
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="link-button"
      title={text}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "copied" : label}
    </button>
  );
}

const FOCUS_ERRORS: Record<string, string> = {
  missing: "tab not found — copy the resume command instead",
  not_authorized: "allow it: System Settings → Privacy & Security → Automation → iTerm → iTerm2",
};

/** Ask the server to bring the run's iTerm tab to the front. Returns an error message, or null. */
async function focusTab(run: Run): Promise<string | null> {
  const res = await fetch(`/api/focus?session=${encodeURIComponent(run.sessionId)}`, { method: "POST", headers: { "X-Agent-Dash": "1" } });
  if (res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return FOCUS_ERRORS[body.result] ?? body.detail ?? `failed (${res.status})`;
}

/** "open tab" for a live run; "copy resume" for a finished one, or when the tab cannot be found. */
function TabOrResume({ run, onError }: { run: Run; onError: (message: string | null) => void }) {
  const [failed, setFailed] = useState(false);
  if (!run.itermSessionId || failed) return <CopyButton text={resumeCommand(run)} label="copy resume" />;
  return (
    <button
      className="link-button open-tab"
      title="Bring this session's iTerm tab to the front"
      onClick={async () => {
        const error = await focusTab(run);
        onError(error);
        if (error) setFailed(true);
      }}
    >
      open tab
    </button>
  );
}

function PrChip({ pr }: { pr: PullRequest }) {
  const review = pr.reviewDecision === "APPROVED" ? "approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes requested" : null;
  return (
    <a className={`pr pr-${pr.state}`} href={pr.url} target="_blank" rel="noreferrer" title={pr.title}>
      <span className="pr-name">{prName(pr.url)}</span>
      <span className="pr-state">{pr.isDraft && pr.state === "open" ? "draft" : pr.state}</span>
      {pr.state === "open" && pr.checks !== "none" && <span className={`ci ci-${pr.checks}`}>CI {pr.checks}</span>}
      {pr.state === "open" && review && <span className={`review review-${pr.reviewDecision}`}>{review}</span>}
      {pr.state === "open" && pr.mergeable === "CONFLICTING" && <span className="ci ci-failure">conflict</span>}
    </a>
  );
}

function RunRow({ run }: { run: Run }) {
  const [tabError, setTabError] = useState<string | null>(null);
  return (
    <li className={`run run-${run.status}`} id={`run-${run.sessionId}`}>
      <div className="run-head">
        <StatusPill run={run} />
        <span className="run-title" title={run.firstPrompt}>
          {run.name ?? run.firstPrompt}
        </span>
      </div>
      <div className="run-meta">
        <span title={run.startedAt}>started {when(run.startedAt)}</span>
        <span title={run.lastActivityAt}>active {ago(run.lastActivityAt)}</span>
        <span title={run.cwd}>{dirLabel(run.cwd)}</span>
        <span>{plural(run.userMessageCount, "prompt")}</span>
        {run.createdPrs.length <= 2 ? (
          run.createdPrs.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              opened {prName(url)}
            </a>
          ))
        ) : (
          <details className="created-prs">
            <summary>opened {run.createdPrs.length} PRs</summary>
            {run.createdPrs.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                {prName(url)}
              </a>
            ))}
          </details>
        )}
        <TabOrResume run={run} onError={setTabError} />
        {tabError && <span className="focus-error">{tabError}</span>}
      </div>
      {run.status === "awaiting_input" && run.lastReply && <div className={`run-reply ${run.askedQuestion ? "question" : ""}`}>{run.lastReply}</div>}
    </li>
  );
}

function Runs({ runs }: { runs: Run[] }) {
  const [all, setAll] = useState(false);
  useEffect(() => {
    const unfold = () => {
      if (runs.some((r) => location.hash === `#run-${r.sessionId}`)) setAll(true);
    };
    window.addEventListener("hashchange", unfold);
    return () => window.removeEventListener("hashchange", unfold);
  }, [runs]);
  if (runs.length === 0) return <div className="muted small">No agent runs yet.</div>;
  // Live runs always show; only old finished runs fold away.
  const visible = all ? runs : runs.filter((r, i) => i >= runs.length - RUNS_SHOWN || r.status !== "finished");
  const hidden = runs.length - visible.length;
  return (
    <>
      {hidden > 0 && (
        <button className="link-button small" onClick={() => setAll(true)}>
          show {plural(hidden, "older run")}
        </button>
      )}
      <ol className="runs">
        {visible.map((r) => (
          <RunRow key={r.sessionId} run={r} />
        ))}
      </ol>
    </>
  );
}

function TicketCard({ group, attention }: { group: TicketGroup; attention: AttentionItem[] }) {
  const { ticket, runs, prs } = group;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = ticket.dueDate && ticket.dueDate < today && ticket.statusCategory !== "done";
  const openPrs = prs.filter((p) => p.state === "open");
  const closedPrs = prs.filter((p) => p.state !== "open");
  return (
    <section className={`ticket ${attention.length ? "needs-you" : ""}`} id={`ticket-${ticket.key}`}>
      <header className="ticket-head">
        <a className="ticket-key" href={ticket.url} target="_blank" rel="noreferrer">
          {ticket.key}
        </a>
        <span className="ticket-summary">{ticket.summary}</span>
        <span className={`pill cat-${ticket.statusCategory}`}>{ticket.status}</span>
        {ticket.priority && <span className="muted small">{ticket.priority}</span>}
        {ticket.dueDate && <span className={`small ${overdue ? "overdue" : "muted"}`}>due {ticket.dueDate}</span>}
      </header>
      {attention.length > 0 && (
        <ul className="ticket-attention">
          {attention.map((a, i) => (
            <li key={i}>{a.reason}</li>
          ))}
        </ul>
      )}
      {prs.length > 0 && (
        <div className="prs">
          {openPrs.map((p) => (
            <PrChip key={p.url} pr={p} />
          ))}
          {closedPrs.length > 0 && (
            <details className="closed-prs">
              <summary className="small muted">{closedPrs.length} merged / closed</summary>
              {closedPrs.map((p) => (
                <PrChip key={p.url} pr={p} />
              ))}
            </details>
          )}
        </div>
      )}
      <Runs runs={runs} />
    </section>
  );
}

const KIND_LABEL: Record<AttentionItem["kind"], string> = {
  awaiting_input: "waiting",
  run_error: "error",
  changes_requested: "changes",
  ci_failing: "CI red",
  merge_conflict: "conflict",
  ready_to_merge: "merge",
  overdue: "overdue",
  due_soon: "due",
  stalled: "stalled",
};

// ---- next-steps summaries ------------------------------------------------------------

/** Same limit as the server: after this, a request counts as stuck. */
const SUMMARY_STALE_MS = 30 * 60_000;

async function requestSummary(ticket: string, force: boolean): Promise<string | null> {
  const res = await fetch(`/api/summaries?ticket=${encodeURIComponent(ticket)}${force ? "&force" : ""}`, { method: "POST", headers: { "X-Agent-Dash": "1" } });
  if (res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return body.error ?? `failed (${res.status})`;
}

/** Just enough markdown for a summary: **bold**, and line breaks kept. */
function SummaryText({ text }: { text: string }) {
  return (
    <div className="summary-text">
      {text.split("\n").map((line, i) => (
        <div key={i}>{line.split(/(\*\*[^*]+\*\*)/g).map((part, j) => (part.startsWith("**") && part.endsWith("**") ? <strong key={j}>{part.slice(2, -2)}</strong> : part))}</div>
      ))}
    </div>
  );
}

type SummaryView = "none" | "running" | "stuck" | "failed" | "done";

function summaryView(state: TicketSummaryState | undefined, now: number): SummaryView {
  if (!state) return "none";
  const { latest } = state;
  if (latest.status === "in_progress") return now - Date.parse(latest.requestedAt) > SUMMARY_STALE_MS ? "stuck" : "running";
  if (latest.status === "failed") return state.lastDone ? "done" : "failed";
  return "done";
}

function SummaryCell({ ticket, state, now, open, onToggle, onError }: {
  ticket: string;
  state: TicketSummaryState | undefined;
  now: number;
  open: boolean;
  onToggle: () => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const ask = async (force: boolean) => {
    setBusy(true);
    onError(await requestSummary(ticket, force));
    setBusy(false);
  };
  const view = summaryView(state, now);
  if (busy) return <span className="muted">starting…</span>;
  if (view === "none") return <button className="link-button" title="Start a pi run that writes next steps for this ticket" onClick={() => ask(false)}>summarize</button>;
  if (view === "running") return <button className="link-button summarizing" onClick={onToggle} title="A pi run is writing the summary">summarizing {sinceLabel(state!.latest.requestedAt, now).replace(" ago", "")}…</button>;
  if (view === "stuck") return <button className="link-button stuck" title="Running for more than 30 minutes" onClick={() => ask(true)}>stuck · re-request</button>;
  if (view === "failed") return <button className="link-button stuck" title={state!.latest.error ?? ""} onClick={() => ask(true)}>failed · retry</button>;
  return <button className="link-button" onClick={onToggle}>summary {open ? "▾" : "▸"}</button>;
}

function SummaryPanel({ ticket, state, now, onError }: { ticket: string; state: TicketSummaryState; now: number; onError: (message: string | null) => void }) {
  const { latest, lastDone } = state;
  const shown = latest.status === "done" ? latest : lastDone;
  const view = summaryView(state, now);
  return (
    <div className="summary-panel">
      {shown?.summary ? <SummaryText text={shown.summary} /> : <div className="muted">No summary yet.</div>}
      <div className="summary-meta">
        {shown && (
          <>
            <span title={shown.requestedAt}>requested {sinceLabel(shown.requestedAt, now)}</span>
            {shown.generatedAt && <span title={shown.generatedAt}>generated {sinceLabel(shown.generatedAt, now)}</span>}
          </>
        )}
        {view === "running" && <span className="summarizing">a new summary is in progress ({sinceLabel(latest.requestedAt, now).replace(" ago", "")})</span>}
        {latest.status === "failed" && <span className="stuck" title={latest.error ?? ""}>the last request failed</span>}
        {(view === "done" || view === "stuck") && (
          <button className="link-button" onClick={async () => onError(await requestSummary(ticket, view === "stuck"))}>
            re-request
          </button>
        )}
      </div>
    </div>
  );
}

function FocusRow({ item, now, summary }: { item: AttentionItem; now: number; summary: TicketSummaryState | undefined }) {
  const [tabError, setTabError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <li className={`focus-item kind-${item.kind}`}>
      <span className="focus-kind">{KIND_LABEL[item.kind]}</span>
      <span className="focus-reason">{item.reason}</span>
      <span className="focus-cell focus-updated" title={item.updatedAt ? new Date(item.updatedAt).toLocaleString() : undefined}>
        {item.updatedAt && sinceLabel(item.updatedAt, now)}
      </span>
      {/* One cell per link, empty when there is none, so each link type lines up in a column. */}
      <span className="focus-cell">
        {item.ticketKey && (
          <a href={item.ticketUrl ?? undefined} target="_blank" rel="noreferrer" title="Open in Jira">
            {item.ticketKey}
          </a>
        )}
      </span>
      <span className="focus-cell">
        {item.prUrl && (
          <a href={item.prUrl} target="_blank" rel="noreferrer">
            PR
          </a>
        )}
      </span>
      <span className="focus-cell">{item.sessionId && <a href={`#run-${item.sessionId}`}>run</a>}</span>
      <span className="focus-cell">{item.run && <TabOrResume run={item.run} onError={setTabError} />}</span>
      <span className="focus-cell">
        {item.ticketKey && <SummaryCell ticket={item.ticketKey} state={summary} now={now} open={open} onToggle={() => setOpen(!open)} onError={setTabError} />}
      </span>
      {tabError && <span className="focus-error focus-row-error">{tabError}</span>}
      {open && item.ticketKey && summary && <SummaryPanel ticket={item.ticketKey} state={summary} now={now} onError={setTabError} />}
    </li>
  );
}

function FocusNext({ items, summaries }: { items: AttentionItem[]; summaries: Dashboard["summaries"] }) {
  const [all, setAll] = useState(false);
  const now = useNow(10_000);
  if (items.length === 0) return <p className="muted">Nothing needs you. The agents are working or done.</p>;
  const shown = all ? items : items.slice(0, 10);
  return (
    <>
      <ol className="focus">
        <li className="focus-item focus-header" aria-hidden>
          <span />
          <span />
          <span className="focus-cell">updated</span>
          <span className="focus-cell">ticket</span>
          <span className="focus-cell">PR</span>
          <span className="focus-cell">run</span>
          <span className="focus-cell">jump</span>
          <span className="focus-cell">next steps</span>
        </li>
        {shown.map((a, i) => (
          <FocusRow key={`${a.kind}-${a.sessionId ?? a.prUrl ?? a.ticketKey}-${i}`} item={a} now={now} summary={a.ticketKey ? summaries[a.ticketKey] : undefined} />
        ))}
      </ol>
      {items.length > shown.length && (
        <button className="link-button small" onClick={() => setAll(true)}>
          show {items.length - shown.length} more
        </button>
      )}
    </>
  );
}

function Health({ name, h }: { name: string; h: SourceHealth }) {
  return (
    <span className={`health ${h.ok ? "ok" : "bad"}`} title={h.ok ? `fetched ${h.fetchedAt ?? ""}` : h.error}>
      {name}
    </span>
  );
}

// ---- page ---------------------------------------------------------------------------

export function App() {
  const { data, error, loading, refresh } = useDashboard();

  // A focus link can point into a collapsed section, so open it before scrolling.
  useEffect(() => {
    // Wait a frame, so a Runs list that unfolds on the same hashchange has rendered the target.
    const reveal = () => requestAnimationFrame(() => {
      const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (!el) return;
      for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    });
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);

  useEffect(() => {
    const waiting = data?.counts.awaiting_input ?? 0;
    document.title = waiting ? `(${waiting}) agent-dash` : "agent-dash";
  }, [data]);

  if (!data) return <main className="page">{error ? <pre className="error">{error}</pre> : <p className="muted">Loading…</p>}</main>;

  const byTicket = new Map<string, AttentionItem[]>();
  for (const a of data.attention) if (a.ticketKey) byTicket.set(a.ticketKey, [...(byTicket.get(a.ticketKey) ?? []), a]);
  const active = data.myTickets.filter((g) => g.runs.length || g.prs.length || byTicket.has(g.ticket.key));
  const quiet = data.myTickets.filter((g) => !active.includes(g));

  return (
    <main className="page">
      <header className="top">
        <h1>agent-dash</h1>
        <span className="pill status-working">{data.counts.working} working</span>
        <span className="pill status-awaiting_input">{data.counts.awaiting_input} awaiting input</span>
        <span className="pill status-finished">{data.counts.finished} finished</span>
        <span className="spacer" />
        <Health name="Jira" h={data.sources.jira} />
        <Health name="GitHub" h={data.sources.github} />
        <Health name="pi logs" h={data.sources.sessions} />
        <span className="muted small">updated {ago(data.generatedAt)}</span>
        <button onClick={refresh} disabled={loading}>
          {loading ? "…" : "refresh"}
        </button>
      </header>
      {error && <pre className="error">{error}</pre>}
      {!data.extensionInstalled && (
        <p className="banner">
          Statuses marked <b>?</b> are guesses from the session log. Run <code>pnpm install-extension</code>, then restart your pi sessions, to get exact statuses.
        </p>
      )}

      <h2>Focus next</h2>
      <FocusNext items={data.attention} summaries={data.summaries} />

      <h2>
        My tickets <span className="muted">({data.myTickets.length})</span>
      </h2>
      {active.map((g) => (
        <TicketCard key={g.ticket.key} group={g} attention={byTicket.get(g.ticket.key) ?? []} />
      ))}
      {quiet.length > 0 && (
        <p className="quiet">
          <span className="muted">No agent activity: </span>
          {quiet.map((g) => (
            <a key={g.ticket.key} href={g.ticket.url} target="_blank" rel="noreferrer" title={`${g.ticket.summary} (${g.ticket.status})`}>
              {g.ticket.key}
            </a>
          ))}
        </p>
      )}

      <details className="section">
        <summary>
          <h2>
            Other tickets with recent runs <span className="muted">({data.otherTickets.length})</span>
          </h2>
        </summary>
        {data.otherTickets.map((g) => (
          <TicketCard key={g.ticket.key} group={g} attention={[]} />
        ))}
      </details>

      <details className="section">
        <summary>
          <h2>
            Runs with no ticket <span className="muted">({data.unlinkedRuns.length})</span>
          </h2>
        </summary>
        <ol className="runs">
          {data.unlinkedRuns.map((r) => (
            <RunRow key={r.sessionId} run={r} />
          ))}
        </ol>
      </details>
    </main>
  );
}
