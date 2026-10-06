import { useEffect, useState } from "react";
import { prRef } from "../../shared/refs.ts";
import { ENV_LABEL, ENVIRONMENTS, isPlanRunning, isPlanStage, isPlanWaiting, isSmoketestRunning, mergePrs, newestPlan, SHARED_ENVS, SMOKETEST_ENV, type SmoketestLane, sdlcProgress, smoketestLanes, type Stage, type StageState } from "../../shared/sdlc.ts";
import type { PullRequest, Run, SdlcEnvironment, SdlcEvent, SmoketestOutcome, TicketGroup } from "../../shared/types.ts";
import { conversationHash, launchAgent, type LaunchBody, ResumeHere } from "./agents.tsx";
import { Chat } from "./chat.tsx";
import { age, Markdown, post, stamp } from "./lib.tsx";
import { Composer, LivePanel } from "./liveControl.tsx";
import { href } from "./routes.ts";

/**
 * The SDLC progress bar at the top of a ticket, and the ticket's Smoketests card. Smoketest plans,
 * smoketest executions and confirmed deploys are rows in SQLite; the PR stage reads GitHub and
 * the Done stage reads Jira. An agent plans each smoketest first. A plan that changes Beta or
 * Prod state runs only after Piper confirms it here.
 */

const TTL_MS = 2 * 60_000;
const prCache = new Map<string, { at: number; value: PullRequest[] }>();

/** The ticket's PRs from any author and any time; the dashboard holds only my recent ones. */
function useTicketPrs(key: string): PullRequest[] {
  const [prs, setPrs] = useState<PullRequest[]>(() => prCache.get(key)?.value ?? []);
  useEffect(() => {
    const hit = prCache.get(key);
    setPrs(hit?.value ?? []);
    if (hit && Date.now() - hit.at < TTL_MS) return;
    let current = true;
    fetch(`/api/ticket-prs?key=${encodeURIComponent(key)}`, { headers: { "X-Agent-Dash": "1" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((value: PullRequest[]) => {
        prCache.set(key, { at: Date.now(), value });
        if (current) setPrs(value);
      })
      // Without the search, the bar still has the dashboard's PRs.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [key]);
  return prs;
}

/** Starts one agent; the button then links to it. */
function AgentVerb({ ticket, body, label, title, onError }: { ticket: string; body: LaunchBody; label: string; title: string; onError: (m: string | null) => void }) {
  const [state, setState] = useState<"idle" | "starting">("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  if (sessionId) {
    return (
      <a className="btn ghost small" href={conversationHash(sessionId)}>
        Started ✓ Open
      </a>
    );
  }
  return (
    <button
      className="btn small"
      title={`${title} ⌥-click opens it in a new iTerm tab.`}
      disabled={state !== "idle" || !body.cwd.trim()}
      onClick={async (e) => {
        setState("starting");
        try {
          const id = await launchAgent(ticket, { ...body, terminal: e.altKey });
          onError(null);
          if (id) setSessionId(id);
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setState("idle");
        }
      }}
    >
      {state === "starting" ? "Starting…" : label}
    </button>
  );
}

function PlanVerb({ ticket, env, cwd, onError, again = false }: { ticket: string; env: SdlcEnvironment; cwd: string; onError: (m: string | null) => void; again?: boolean }) {
  return (
    <AgentVerb
      ticket={ticket}
      body={{ cwd, sdlc: { kind: "smoketest_plan", env } }}
      label={again ? "Plan again" : `Plan smoketest on ${ENV_LABEL[env]}`}
      title={`Start an agent in ${cwd} that plans a smoketest of ${ticket} on ${ENV_LABEL[env]}. A plan that changes no Beta or Prod state runs at once; any other plan waits for your Confirm.`}
      onError={onError}
    />
  );
}

/**
 * Confirm approves the state changes of the plan version on the page, and starts its run. On an
 * accepted plan, it runs the plan again.
 */
function RunPlan({ plan, cwd, onError, primary = true }: { plan: SdlcEvent; cwd: string; onError: (m: string | null) => void; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const waiting = isPlanWaiting(plan);
  return (
    <button
      className={`btn small ${primary ? "primary" : "ghost"}`}
      disabled={busy || !plan.plannedAt}
      title={waiting ? "Approve the state changes that this plan lists, and let the agent run it" : "Run this accepted plan again"}
      onClick={async () => {
        setBusy(true);
        onError(await post(`/api/sdlc-events/run?id=${plan.id}`, { plannedAt: plan.plannedAt, cwd }));
        setBusy(false);
      }}
    >
      {busy ? "Starting…" : waiting ? "Confirm" : "Run the plan again"}
    </button>
  );
}

/** The Smoketests card opens the lane that holds the event, so the row exists to scroll to. */
const OPEN_EVENT = "agent-dash:open-sdlc-event";

function scrollTo(id: string) {
  return (e: { preventDefault: () => void }) => {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
    // Two frames: React renders the opened drawer in the first.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const row = document.getElementById(id);
        // A settled row is closed, and the link is there to show it.
        const item = row?.querySelector<HTMLDetailsElement>(":scope > details.smoke-item");
        if (item) item.open = true;
        row?.scrollIntoView({ behavior: "smooth" });
      }),
    );
  };
}

/** Records a smoketest that Piper chose not to run, so its stage counts as passed. */
function SkipSmoketest({ ticket, env, onError }: { ticket: string; env: SdlcEnvironment; onError: (m: string | null) => void }) {
  return (
    <button
      className="btn ghost small"
      title={`Record that you skip the ${ENV_LABEL[env]} smoketest of ${ticket}. Delete it on the Smoketests card to undo.`}
      onClick={async () => {
        const now = new Date().toISOString();
        onError(await post("/api/sdlc-events", { eventType: "smoketest_execution", tickets: [ticket], environments: [env], startedAt: now, skippedAt: now }));
      }}
    >
      Skip smoketest
    </button>
  );
}

const OUTCOME_TONE: Record<SmoketestOutcome, string> = { passed: "tone-good", failed: "tone-bad", blocked: "tone-muted" };

const STATE_TEXT: Record<StageState, string> = { done: "done", failed: "failed", blocked: "blocked", running: "running", waiting: "waiting", skipped: "skipped", todo: "to do" };

/** Its card in the ticket view; its page until pi writes the log. */
function agentHref(sessionId: string, runs: Run[]): string {
  return runs.some((r) => r.sessionId === sessionId) ? href(`r:${sessionId}`) : conversationHash(sessionId);
}

/** The agent link of a stage whose newest plan or smoketest is running, if agent-dash started it. */
function runningAgent(stage: Stage, runs: Run[]): string | null {
  const id = stage.state === "running" ? stage.events[0]?.sessionId : null;
  return id ? agentHref(id, runs) : null;
}

/** A smoketest stage, plan or execution: what to do with the newest plan of its environment. */
function SmoketestActions({ stage, group, env, events, cwd, onError, links = true }: { stage: Stage; group: TicketGroup; env: SdlcEnvironment; events: SdlcEvent[]; cwd: string; onError: (m: string | null) => void; links?: boolean }) {
  const key = group.ticket.key;
  const agent = runningAgent(stage, group.runs);
  const plan = newestPlan(events, env);
  const planAgent = plan && isPlanRunning(plan) && plan.sessionId ? agentHref(plan.sessionId, group.runs) : null;
  const passed = stage.state === "done" || stage.state === "skipped";
  let verb;
  if (agent) {
    verb = (
      <a className="btn small" href={agent}>
        {isPlanStage(stage.id) ? "Open the planning agent" : "Open the smoketest"}
      </a>
    );
  } else if (planAgent) {
    verb = (
      <a className="btn small" href={planAgent}>
        Open the planning agent
      </a>
    );
  } else if (plan && isPlanWaiting(plan)) {
    verb = <RunPlan plan={plan} cwd={cwd} onError={onError} />;
  } else if (plan?.confirmedAt && !isPlanStage(stage.id) && !passed) {
    verb = <RunPlan plan={plan} cwd={cwd} onError={onError} />;
  } else {
    verb = <PlanVerb ticket={key} env={env} cwd={cwd} onError={onError} again={!!plan} />;
  }
  return (
    <>
      {verb}
      {!passed && !agent && <SkipSmoketest ticket={key} env={env} onError={onError} />}
      {links && plan && (
        <a className="btn ghost small" href={`#sdlc:${plan.id}`} onClick={scrollTo(`sdlc:${plan.id}`)}>
          See the plan
        </a>
      )}
      {links && !isPlanStage(stage.id) && stage.events.length > 0 && (
        <a className="btn ghost small" href="#smoketests" onClick={scrollTo("smoketests")}>
          See smoketests
        </a>
      )}
    </>
  );
}

function StageActions({ stage, group, events, cwd, onError }: { stage: Stage; group: TicketGroup; events: SdlcEvent[]; cwd: string; onError: (m: string | null) => void }) {
  const key = group.ticket.key;
  const env = SMOKETEST_ENV[stage.id];
  if (env) return <SmoketestActions stage={stage} group={group} env={env} events={events} cwd={cwd} onError={onError} />;
  if (stage.id === "in_beta" || stage.id === "in_prod") {
    const where = stage.id === "in_beta" ? "beta" : "prod";
    const envId: SdlcEnvironment = where === "beta" ? "postman_beta" : "postman_prod";
    if (stage.state === "done") {
      const last = stage.events[0];
      return last ? (
        <button
          className="btn ghost small"
          title={last.testDetails ?? ""}
          onClick={async () => {
            if (confirm(`Remove the ${stage.label} check from ${stamp(last.startedAt)}?`)) onError(await post(`/api/sdlc-events?id=${last.id}`, undefined, "DELETE"));
          }}
        >
          Undo
        </button>
      ) : null;
    }
    return (
      <>
        {/* Always offered: the deploy can be live before the board sees its PR or earlier stages. */}
        <AgentVerb
          ticket={key}
          body={{ cwd, sdlc: { kind: "confirm_deploy", stage: where } }}
          label="Confirm in Argo"
          title={`Start an agent that checks the ${ENV_LABEL[envId]} deploy in Argo, read-only, and records it here.`}
          onError={onError}
        />
        <button
          className="btn ghost small"
          title="For a change with no Argo deploy, or one you checked yourself"
          onClick={async () => {
            if (!confirm(`Check off "${stage.label}" for ${key} by hand?`)) return;
            onError(await post("/api/sdlc-events", { eventType: "deploy", tickets: [key], environments: [envId], testDetails: "Checked off by hand in agent-dash" }));
          }}
        >
          Check off by hand
        </button>
      </>
    );
  }
  if (stage.id === "review_requested") {
    const last = stage.events[0];
    return last?.messageUrl ? (
      <a className="btn ghost small" href={last.messageUrl} target="_blank" rel="noreferrer">
        Open in Slack ↗
      </a>
    ) : stage.state !== "done" ? (
      <a className="btn small" href={href("prs")} title="The PRs view has a drafted Slack review request under each open PR">
        Request review
      </a>
    ) : null;
  }
  if (stage.id === "pr") {
    const pr = group.prs.find((p) => p.state !== "closed");
    const ref = pr && prRef(pr.url);
    return ref ? (
      <a className="btn ghost small" href={href(ref)}>
        Open the PR
      </a>
    ) : null;
  }
  return null;
}

/** The bar's lamp text, also on the Smoketests card, so a state looks the same in both places. */
function stageGlyph(s: Stage, n: number | string): string | number {
  return s.state === "done" ? "✓" : s.state === "failed" ? "!" : s.state === "blocked" ? "?" : s.state === "running" ? "…" : s.state === "waiting" && isPlanStage(s.id) ? "↵" : n;
}

export function SdlcBar({ group, events, cwd, onError }: { group: TicketGroup; events: SdlcEvent[]; cwd: string; onError: (m: string | null) => void }) {
  const searched = useTicketPrs(group.ticket.key);
  const progress = sdlcProgress({ ticket: group.ticket, prs: mergePrs(group.prs, searched), events });
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => setPicked(null), [group.ticket.key]);
  const shown = progress.stages[picked ?? progress.current + 1] ?? null;
  return (
    <div className="sdlc">
      <ol className="sdlc-bar" aria-label="SDLC progress">
        {progress.stages.map((s, i) => {
          const title = `${s.label}: ${STATE_TEXT[s.state]}${s.detail ? ` · ${s.detail}` : ""}`;
          const inner = (
            <>
              <span className="sdlc-dot">{stageGlyph(s, i + 1)}</span>
              <span className="sdlc-label">{s.label}</span>
            </>
          );
          const agent = runningAgent(s, group.runs);
          return (
            <li key={s.id} className={`sdlc-stage st-${s.state} ${i === progress.current ? "current" : ""} ${s === shown ? "picked" : ""}`}>
              {agent ? (
                <a href={agent} onClick={() => setPicked(i)} title={`${title} · open its agent`}>
                  {inner}
                </a>
              ) : (
                <button type="button" onClick={() => setPicked(i)} title={title}>
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {shown ? (
        <div className="sdlc-detail">
          <span className={`tag st-tag-${shown.state}`}>{STATE_TEXT[shown.state]}</span>
          <span>
            <b>{shown === progress.next ? "Next: " : `${shown.label}: `}</b>
            {shown === progress.next ? progress.hint : shown.detail}
          </span>
          <span className="grow" />
          <StageActions stage={shown} group={group} events={events} cwd={cwd} onError={onError} />
        </div>
      ) : (
        <div className="sdlc-detail meta">Every stage is done.</div>
      )}
    </div>
  );
}

// ---- Smoketests card ------------------------------------------------------------------

/** A datetime-local value for now, in local time, as the input wants it. */
function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function RecordForm({ ticket, onError, onDone }: { ticket: string; onError: (m: string | null) => void; onDone: () => void }) {
  const [envs, setEnvs] = useState<SdlcEnvironment[]>(["localhost"]);
  const [outcome, setOutcome] = useState<SmoketestOutcome>("passed");
  const [startedAt, setStartedAt] = useState(localNow);
  const [finishedAt, setFinishedAt] = useState(localNow);
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [results, setResults] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const err = await post("/api/sdlc-events", {
      eventType: "smoketest_execution",
      tickets: [ticket],
      environments: envs,
      outcome,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
      summary,
      testDetails: details,
      testResults: results,
    });
    setSaving(false);
    onError(err);
    if (!err) onDone();
  };
  return (
    <div className="smoke-form">
      <div className="smoke-row">
        <span className="meta">Environment under test</span>
        {ENVIRONMENTS.map((e) => (
          <label key={e.id} className="check">
            <input type="checkbox" checked={envs.includes(e.id)} onChange={(ev) => setEnvs(ev.target.checked ? [...envs, e.id] : envs.filter((x) => x !== e.id))} />
            {e.label}
          </label>
        ))}
      </div>
      <div className="smoke-row">
        <label className="check">
          Outcome{" "}
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as SmoketestOutcome)}>
            <option value="passed">passed</option>
            <option value="failed">failed</option>
            <option value="blocked">blocked</option>
          </select>
        </label>
        <label className="check">
          Started <input type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
        </label>
        <label className="check">
          Finished <input type="datetime-local" value={finishedAt} onChange={(e) => setFinishedAt(e.target.value)} />
        </label>
      </div>
      <div className="composer">
        <input value={summary} maxLength={200} placeholder="Summary: one line that says what the test showed" onChange={(e) => setSummary(e.target.value)} />
      </div>
      <div className="composer">
        <textarea rows={2} value={details} placeholder="Test details: what you tested and how (stack, commands, URLs, versions)" onChange={(e) => setDetails(e.target.value)} />
      </div>
      <div className="composer">
        <textarea rows={2} value={results} placeholder="Test results: what you saw, with the evidence" onChange={(e) => setResults(e.target.value)} />
      </div>
      <div className="smoke-row">
        <span className="grow" />
        <button className="btn ghost small" onClick={onDone}>
          Cancel
        </button>
        <button className="btn small" onClick={save} disabled={saving || !envs.length || !startedAt}>
          {saving ? "Saving…" : "Save smoketest"}
        </button>
      </div>
    </div>
  );
}

/**
 * The first prose line of a markdown text: no heading, no list or quote marker, no emphasis. Only
 * rows from before summaries use it, and their first line can be a whole paragraph, so it is cut.
 */
function firstLine(md: string | null): string | null {
  const line = md?.split("\n").find((l) => l.trim() && !/^\s*(#|```|---|\|)/.test(l));
  const text = line?.replace(/^[>*\-\s\d.]+/, "").replace(/[*_`]/g, "") ?? "";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text || null;
}

/** The one line on a finished smoketest's collapsed row. Rows from before summaries show the first line of their results. */
function summaryLine(e: SdlcEvent): string {
  return e.summary ?? firstLine(e.testResults) ?? firstLine(e.testDetails) ?? "No summary";
}

function SmoketestRow({ e, now, runs, onError }: { e: SdlcEvent; now: number; runs: Run[]; onError: (m: string | null) => void }) {
  const running = isSmoketestRunning(e);
  const ran = e.finishedAt ? Math.round((Date.parse(e.finishedAt) - Date.parse(e.startedAt)) / 60_000) : null;
  const full = (
    <>
      <div className="note-meta">
        <span title={e.startedAt}>{stamp(e.startedAt)}</span>
        <span>· {age(e.startedAt, now)} ago</span>
        {ran !== null && <span>· ran {ran < 1 ? "<1" : ran} min</span>}
        {e.environments.map((x) => (
          <span key={x} className="tag tone-working">
            {ENV_LABEL[x]}
          </span>
        ))}
        {running && <span className="tag tone-running">running</span>}
        {running && e.sessionId && <a href={agentHref(e.sessionId, runs)}>Open the agent</a>}
        {e.skippedAt && <span className="tag">skipped</span>}
        {e.outcome && <span className={`tag ${OUTCOME_TONE[e.outcome]}`}>{e.outcome}</span>}
        {e.planId && (
          <a href={`#sdlc:${e.planId}`} onClick={scrollTo(`sdlc:${e.planId}`)}>
            · its plan
          </a>
        )}
        {e.tickets.length > 1 && <span>· also on {e.tickets.slice(1).join(", ")}</span>}
        <button
          className="btn ghost small note-delete"
          onClick={async () => {
            if (confirm("Delete this smoketest?")) onError(await post(`/api/sdlc-events?id=${e.id}`, undefined, "DELETE"));
          }}
        >
          Delete
        </button>
      </div>
      {e.testDetails && <Markdown text={e.testDetails} />}
      {e.testResults && (
        <details className="smoke-results">
          <summary>Results</summary>
          <Markdown text={e.testResults} />
        </details>
      )}
    </>
  );
  // A finished smoketest shows only its outcome and the agent's one-line summary until you click it.
  if (!e.outcome || running) return <li id={`sdlc:${e.id}`}>{full}</li>;
  return (
    <li id={`sdlc:${e.id}`}>
      <details className="smoke-item">
        <summary title="Show the full results">
          <span className={`tag ${OUTCOME_TONE[e.outcome]}`}>{e.outcome}</span>
          <span className="smoke-summary">{summaryLine(e)}</span>
          <span className="meta" title={e.startedAt}>
            {e.environments.map((x) => ENV_LABEL[x]).join(", ")} · {age(e.startedAt, now)} ago
          </span>
        </summary>
        <div className="smoke-full">{full}</div>
      </details>
    </li>
  );
}

function planStatus(e: SdlcEvent): { text: string; tone: string } {
  if (isPlanRunning(e)) return { text: "planning", tone: "tone-running" };
  if (isPlanWaiting(e)) return { text: "waits for your confirmation", tone: "st-tag-waiting" };
  return e.confirmedBy === "auto" ? { text: "accepted: no Beta or Prod state changes", tone: "tone-good" } : { text: "confirmed by you", tone: "tone-good" };
}

/** The planning agent's chat, with a reply box while it lives, so Piper can refine the plan here. */
function PlanConversation({ sessionId, runs, now, onError }: { sessionId: string; runs: Run[]; now: number; onError: (m: string | null) => void }) {
  const run = runs.find((r) => r.sessionId === sessionId);
  if (!run) return <p className="meta">Starting the planning agent…</p>;
  return (
    <div className="plan-chat">
      <Chat sessionId={sessionId} refreshKey={run.status === "working" ? run.userMessageCount : run.lastActivityAt + run.status} firstPrompt="agent-dash's plan prompt" />
      <LivePanel run={run} now={now} onError={onError} working="The agent is working on the plan…" />
      {run.status !== "finished" ? (
        <Composer run={run} onError={onError} focusSignal={0} />
      ) : (
        <div className="smoke-row">
          <span className="meta">The planning agent ended.</span>
          <ResumeHere run={run} onError={onError} small />
        </div>
      )}
    </div>
  );
}

/**
 * The two things Piper decides Confirm on, first: what the plan writes where, and what it does.
 * A plan from before the summaries shows its state changes and its full text instead.
 */
function PlanSummary({ e, waiting }: { e: SdlcEvent; waiting: boolean }) {
  const full = (
    <details className="smoke-results" open={waiting && !e.summary}>
      <summary>The full plan</summary>
      <Markdown text={e.testDetails ?? ""} />
    </details>
  );
  return (
    <div className="plan-summary">
      <div className={`plan-section ${e.stateChanges ? "plan-changes" : ""}`}>
        <b>Writes</b>
        {e.stateChanges ? (
          <>
            {e.writesSummary && <Markdown text={e.writesSummary} />}
            <details className="smoke-results" open={waiting && !e.writesSummary}>
              <summary>The exact state changes that Confirm approves</summary>
              <Markdown text={e.stateChanges} />
            </details>
          </>
        ) : (
          <p>None: no state changes on {SHARED_ENVS}.</p>
        )}
      </div>
      <div className="plan-section">
        <b>Plan</b>
        {e.summary && <Markdown text={e.summary} />}
        {full}
      </div>
    </div>
  );
}

function PlanRow({ e, now, runs, cwd, onError }: { e: SdlcEvent; now: number; runs: Run[]; cwd: string; onError: (m: string | null) => void }) {
  const waiting = isPlanWaiting(e);
  const running = isPlanRunning(e);
  const open = running || waiting;
  // A waiting plan's chat repeats its summaries at length, so it opens on request.
  const [chat, setChat] = useState(running);
  const status = planStatus(e);
  const full = (
    <>
      <div className="note-meta">
        <span title={e.startedAt}>{stamp(e.startedAt)}</span>
        <span>· {age(e.startedAt, now)} ago</span>
        <span className="tag">plan</span>
        {e.environments.map((x) => (
          <span key={x} className="tag tone-working">
            {ENV_LABEL[x]}
          </span>
        ))}
        <span className={`tag ${status.tone}`}>{status.text}</span>
        {e.plannedAt && <span title={e.plannedAt}>· version of {stamp(e.plannedAt)}</span>}
        <button
          className="btn ghost small note-delete"
          onClick={async () => {
            if (confirm("Delete this plan? Its smoketests stay.")) onError(await post(`/api/sdlc-events?id=${e.id}`, undefined, "DELETE"));
          }}
        >
          Delete
        </button>
      </div>
      {waiting && (
        <div className="smoke-row plan-confirm">
          <RunPlan plan={e} cwd={cwd} onError={onError} />
          <span className="meta">Confirm approves the state changes under Writes, and only those. To change the plan, ask the agent for changes.</span>
        </div>
      )}
      {e.plannedAt && <PlanSummary e={e} waiting={waiting} />}
      {e.sessionId &&
        (chat ? (
          <PlanConversation sessionId={e.sessionId} runs={runs} now={now} onError={onError} />
        ) : (
          <button className="btn ghost small chat-toggle" onClick={() => setChat(true)}>
            {waiting ? "Ask the agent for changes" : "Show the planning conversation"}
          </button>
        ))}
    </>
  );
  if (open) return <li id={`sdlc:${e.id}`} className="plan-row open">{full}</li>;
  // A settled plan is a decision already made: one line, like a finished smoketest.
  return (
    <li id={`sdlc:${e.id}`} className="plan-row">
      <details className="smoke-item">
        <summary title="Show the plan">
          <span className={`tag ${status.tone}`}>plan</span>
          <span className="smoke-summary">{e.summary ?? firstLine(e.testDetails) ?? "No summary"}</span>
          <span className="meta" title={e.startedAt}>
            {e.environments.map((x) => ENV_LABEL[x]).join(", ")} · {age(e.startedAt, now)} ago
          </span>
        </summary>
        <div className="smoke-full">{full}</div>
      </details>
    </li>
  );
}

/** One execution's history dot: its outcome, or what it is instead of one. */
function runTone(e: SdlcEvent): SmoketestOutcome | "running" | "skipped" {
  return e.skippedAt ? "skipped" : isSmoketestRunning(e) ? "running" : (e.outcome ?? "passed");
}

const RUN_TAG: Record<ReturnType<typeof runTone>, string> = { ...OUTCOME_TONE, running: "tone-running", skipped: "" };

/** Older runs than this collapse into a count; the newest decide the stage. */
const HISTORY_SHOWN = 12;

/** What the lane's newest plan or execution says, in one or two lines. */
function LaneLatest({ lane, now, after }: { lane: SmoketestLane; now: number; after: string | null }) {
  const e = lane.events[0];
  const later = after && <span className="meta"> · after {after}</span>;
  if (!e) return <span className="meta">No smoketest yet{later}</span>;
  const when = (
    <span className="meta">
      {" "}
      · {e.environments.map((x) => ENV_LABEL[x]).join(", ")} · {age(e.startedAt, now)} ago
    </span>
  );
  if (e.eventType === "smoketest_execution") {
    return (
      <span className="lane-text">
        <span className={`tag ${RUN_TAG[runTone(e)]}`}>{runTone(e)}</span> {isSmoketestRunning(e) ? "An agent runs the plan" : summaryLine(e)}
        {when}
        {later}
      </span>
    );
  }
  const waiting = isPlanWaiting(e);
  const tag = isPlanRunning(e) ? "planning" : waiting ? "to confirm" : "plan";
  // A waiting plan's row is where Piper approves it, so it shows what Confirm lets the agent write.
  const text = waiting && e.writesSummary ? `Writes: ${e.writesSummary}` : isPlanRunning(e) ? "An agent writes the plan" : (e.summary ?? firstLine(e.testDetails) ?? "");
  return (
    <span className={`lane-text ${waiting ? "lane-writes" : ""}`}>
      <span className={`tag ${planStatus(e).tone}`}>{tag}</span> {text}
      {when}
      {later}
    </span>
  );
}

function Lane({ lane, group, events, now, cwd, open, onToggle, after, onError }: { lane: SmoketestLane; group: TicketGroup; events: SdlcEvent[]; now: number; cwd: string; open: boolean; onToggle: () => void; after: string | null; onError: (m: string | null) => void }) {
  // Two environments share the Beta and Prod stages; the select picks where the next plan runs.
  const [env, setEnv] = useState(lane.env);
  useEffect(() => setEnv(lane.env), [lane.env]);
  const shown = lane.runs.slice(-HISTORY_SHOWN);
  // The row offers its verbs only where you act now; an open drawer offers them for any lane.
  const urgent = lane.emphasis === "next" || [lane.plan.state, lane.run.state].some((x) => x === "waiting" || x === "running");
  const actions = (
    <span className="lane-actions">
      {lane.envs.length > 1 && (
        <select value={env} onChange={(e) => setEnv(e.target.value as SdlcEnvironment)} aria-label={`Environment of the ${lane.label} smoketest`}>
          {lane.envs.map((x) => (
            <option key={x} value={x}>
              {ENV_LABEL[x]}
            </option>
          ))}
        </select>
      )}
      <SmoketestActions stage={lane.run} group={group} env={env} events={events} cwd={cwd} onError={onError} links={false} />
    </span>
  );
  return (
    <li className={`lane lane-${lane.emphasis} ${open ? "open" : ""}`}>
      <div className="lane-row">
        <button type="button" className="lane-toggle" onClick={onToggle} aria-expanded={open} title={`${open ? "Hide" : "Show"} its plans and smoketests`}>
          <span className="lane-label">{lane.label}</span>
          {[lane.plan, lane.run].map((s) => (
            <span key={s.id} className={`lane-lamp st-${s.state}`} title={`${s.label}: ${STATE_TEXT[s.state]} · ${s.detail}`}>
              <span className="sdlc-dot">{stageGlyph(s, "")}</span>
            </span>
          ))}
          <span className="lane-history">
            {lane.runs.length > shown.length && <span className="meta">+{lane.runs.length - shown.length}</span>}
            {shown.map((e) => (
              <span key={e.id} className={`run-dot run-${runTone(e)}`} title={`${runTone(e)} · ${ENV_LABEL[e.environments[0]]} · ${age(e.startedAt, now)} ago · ${summaryLine(e)}`} />
            ))}
          </span>
          <LaneLatest lane={lane} now={now} after={after} />
        </button>
        {(urgent || open) && actions}
      </div>
      {open && !lane.events.length && <p className="meta lane-drawer">No plan or smoketest on {lane.envs.map((x) => ENV_LABEL[x]).join(" or ")} yet.</p>}
      {open && lane.events.length > 0 && (
        <ol className="note-list lane-drawer">
          {lane.events.map((e) => (e.eventType === "smoketest_plan" ? <PlanRow key={e.id} e={e} now={now} runs={group.runs} cwd={cwd} onError={onError} /> : <SmoketestRow key={e.id} e={e} now={now} runs={group.runs} onError={onError} />))}
        </ol>
      )}
    </li>
  );
}

/**
 * One lane per smoketest stage pair of the bar, so the state of each environment reads at a
 * glance. A lane's plans and executions open under it, one lane at a time.
 */
export function Smoketests({ group, events, now, cwd, onError }: { group: TicketGroup; events: SdlcEvent[]; now: number; cwd: string; onError: (m: string | null) => void }) {
  const key = group.ticket.key;
  const searched = useTicketPrs(key);
  const progress = sdlcProgress({ ticket: group.ticket, prs: mergePrs(group.prs, searched), events });
  const lanes = smoketestLanes(progress, events);
  const [recording, setRecording] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setOpen(null), [key]);
  useEffect(() => {
    const show = (e: Event) => {
      const id = Number((e as CustomEvent<string>).detail.replace("sdlc:", ""));
      const lane = lanes.find((l) => l.events.some((x) => x.id === id));
      if (lane) setOpen(lane.id);
    };
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, [lanes]);
  return (
    <section className="card smoketests" id="smoketests">
      <header className="card-head">
        <h3>Smoketests</h3>
        <span className="grow" />
        {!recording && (
          <button className="btn ghost small" onClick={() => setRecording(true)} title="Record a smoketest you ran yourself">
            Record by hand
          </button>
        )}
      </header>
      {recording && <RecordForm ticket={key} onError={onError} onDone={() => setRecording(false)} />}
      <div className="lane-head meta" aria-hidden>
        <span />
        <span>Plan</span>
        <span>Run</span>
        <span>History</span>
        <span>Latest</span>
      </div>
      <ol className="lanes">
        {lanes.map((l) => (
          <Lane key={l.id} lane={l} group={group} events={events} now={now} cwd={cwd} open={open === l.id} onToggle={() => setOpen(open === l.id ? null : l.id)} after={l.emphasis === "later" ? (progress.next?.label ?? null) : null} onError={onError} />
        ))}
      </ol>
    </section>
  );
}
