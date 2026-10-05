import { useEffect, useState } from "react";
import { prRef } from "../../shared/refs.ts";
import { ENV_LABEL, ENVIRONMENTS, isRunning, mergePrs, SMOKETEST_ENV, sdlcProgress, type Stage, type StageState } from "../../shared/sdlc.ts";
import type { PullRequest, Run, SdlcEnvironment, SdlcEvent, TicketGroup } from "../../shared/types.ts";
import { conversationHash, launchAgent, type LaunchBody } from "./agents.tsx";
import { age, Markdown, post, stamp } from "./lib.tsx";
import { href } from "./routes.ts";

/**
 * The SDLC progress bar at the top of a ticket, and the ticket's Smoketests card. Smoketests and
 * confirmed deploys are rows in SQLite; the PR stage reads GitHub and the Done stage reads Jira.
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

function SmoketestVerb({ ticket, env, cwd, onError }: { ticket: string; env: SdlcEnvironment; cwd: string; onError: (m: string | null) => void }) {
  return (
    <AgentVerb
      ticket={ticket}
      body={{ cwd, sdlc: { kind: "smoketest", env } }}
      label={`Run smoketest on ${ENV_LABEL[env]}`}
      title={`Start an agent in ${cwd} that smoketests ${ticket} on ${ENV_LABEL[env]} and records the result here.`}
      onError={onError}
    />
  );
}

const STATE_TEXT: Record<StageState, string> = { done: "done", failed: "failed", running: "running", waiting: "waiting", skipped: "skipped", todo: "to do" };

/** The agent of a running smoketest: its card in the ticket view, or its page until pi has written the log. */
function agentHref(sessionId: string, runs: Run[]): string {
  return runs.some((r) => r.sessionId === sessionId) ? href(`r:${sessionId}`) : conversationHash(sessionId);
}

/** The agent link of a stage whose newest smoketest is running, if agent-dash started it. */
function runningAgent(stage: Stage, runs: Run[]): string | null {
  const id = stage.state === "running" ? stage.events[0]?.sessionId : null;
  return id ? agentHref(id, runs) : null;
}

function StageActions({ stage, group, cwd, onError }: { stage: Stage; group: TicketGroup; cwd: string; onError: (m: string | null) => void }) {
  const key = group.ticket.key;
  const env = SMOKETEST_ENV[stage.id];
  if (env) {
    const agent = runningAgent(stage, group.runs);
    return (
      <>
        {agent ? (
          <a className="btn small" href={agent}>
            Open the smoketest
          </a>
        ) : (
          <SmoketestVerb ticket={key} env={env} cwd={cwd} onError={onError} />
        )}
        {stage.events.length > 0 && (
          <a className="btn ghost small" href="#smoketests" onClick={(e) => (e.preventDefault(), document.getElementById("smoketests")?.scrollIntoView({ behavior: "smooth" }))}>
            See smoketests
          </a>
        )}
      </>
    );
  }
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
        {stage.state === "waiting" && (
          <AgentVerb
            ticket={key}
            body={{ cwd, sdlc: { kind: "confirm_deploy", stage: where } }}
            label="Confirm in Argo"
            title={`Start an agent that checks the ${ENV_LABEL[envId]} deploy in Argo, read-only, and records it here.`}
            onError={onError}
          />
        )}
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
              <span className="sdlc-dot">{s.state === "done" ? "✓" : s.state === "failed" ? "!" : s.state === "running" ? "…" : i + 1}</span>
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
          <StageActions stage={shown} group={group} cwd={cwd} onError={onError} />
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
  const [outcome, setOutcome] = useState<"passed" | "failed">("passed");
  const [startedAt, setStartedAt] = useState(localNow);
  const [finishedAt, setFinishedAt] = useState(localNow);
  const [details, setDetails] = useState("");
  const [results, setResults] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const err = await post("/api/sdlc-events", {
      eventType: "smoketest",
      tickets: [ticket],
      environments: envs,
      outcome,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
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
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as "passed" | "failed")}>
            <option value="passed">passed</option>
            <option value="failed">failed</option>
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

function SmoketestRow({ e, now, runs, onError }: { e: SdlcEvent; now: number; runs: Run[]; onError: (m: string | null) => void }) {
  const ran = e.finishedAt ? Math.round((Date.parse(e.finishedAt) - Date.parse(e.startedAt)) / 60_000) : null;
  return (
    <li id={`sdlc:${e.id}`}>
      <div className="note-meta">
        <span title={e.startedAt}>{stamp(e.startedAt)}</span>
        <span>· {age(e.startedAt, now)} ago</span>
        {ran !== null && <span>· ran {ran < 1 ? "<1" : ran} min</span>}
        {e.environments.map((x) => (
          <span key={x} className="tag tone-working">
            {ENV_LABEL[x]}
          </span>
        ))}
        {isRunning(e) && <span className="tag tone-running">running</span>}
        {isRunning(e) && e.sessionId && <a href={agentHref(e.sessionId, runs)}>Open the agent</a>}
        {e.outcome && <span className={`tag ${e.outcome === "passed" ? "tone-good" : "tone-bad"}`}>{e.outcome}</span>}
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
    </li>
  );
}

export function Smoketests({ ticket, events, runs, now, cwd, onError }: { ticket: string; events: SdlcEvent[]; runs: Run[]; now: number; cwd: string; onError: (m: string | null) => void }) {
  const smoketests = events.filter((e) => e.eventType === "smoketest");
  const [recording, setRecording] = useState(false);
  const [env, setEnv] = useState<SdlcEnvironment>("localhost");
  return (
    <section className="card smoketests" id="smoketests">
      <header className="card-head">
        <h3>Smoketests</h3>
        <span className="meta">newest first</span>
        <span className="grow" />
        <select value={env} onChange={(e) => setEnv(e.target.value as SdlcEnvironment)} aria-label="Environment to smoketest">
          {ENVIRONMENTS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <SmoketestVerb key={env} ticket={ticket} env={env} cwd={cwd} onError={onError} />
        {!recording && (
          <button className="btn ghost small" onClick={() => setRecording(true)} title="Record a smoketest you ran yourself">
            Record by hand
          </button>
        )}
      </header>
      {recording && <RecordForm ticket={ticket} onError={onError} onDone={() => setRecording(false)} />}
      {smoketests.length ? (
        <ol className="note-list">
          {smoketests.map((e) => (
            <SmoketestRow key={e.id} e={e} now={now} runs={runs} onError={onError} />
          ))}
        </ol>
      ) : (
        <p className="meta">No smoketest yet. An agent records one with scripts/sdlc-event.ts.</p>
      )}
    </section>
  );
}
