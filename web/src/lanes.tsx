import { useEffect, useState } from "react";
import { landBlocker, laneGitText, MAX_LANES, type LaneRequest } from "../../shared/lanes.ts";
import type { LaneMode, PullRequest, WorkLane, WorktreeInfo } from "../../shared/types.ts";
import { conversationHash } from "./agents.tsx";
import { age, dirLabel, post, prName } from "./lib.tsx";

export interface LaneDraft extends LaneRequest {}

export const FIRST_LANES: LaneDraft[] = [
  { name: "a", message: "" },
  { name: "b", message: "" },
];

/** The next free one-letter name, so a new row needs no naming. */
function nextName(lanes: LaneDraft[]): string {
  const used = new Set(lanes.map((l) => l.name));
  return [..."abcdefghijklmnopqrstuvwxyz"].find((c) => !used.has(c)) ?? `l${lanes.length + 1}`;
}

/** One name and first message per lane, how the lanes come back, and the base branch. */
export function LanesEditor({ ticket, lanes, setLanes, mode, setMode, base, setBase }: { ticket: string; lanes: LaneDraft[]; setLanes: (l: LaneDraft[]) => void; mode: LaneMode; setMode: (m: LaneMode) => void; base: string; setBase: (b: string) => void }) {
  const slug = ticket.toLowerCase();
  const set = (i: number, patch: Partial<LaneDraft>) => setLanes(lanes.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="wl-editor">
      {lanes.map((l, i) => (
        <div className="wl-draft" key={i}>
          <input className="wl-name" value={l.name} onChange={(e) => set(i, { name: e.target.value.toLowerCase() })} spellCheck={false} aria-label="Lane name" title={`Branch ${slug}-${l.name}`} />
          <textarea rows={2} value={l.message} placeholder={`What lane ${l.name} does…`} onChange={(e) => set(i, { message: e.target.value })} />
          {lanes.length > 2 && (
            <button className="btn ghost small" onClick={() => setLanes(lanes.filter((_, j) => j !== i))} aria-label={`Remove lane ${l.name}`}>
              ×
            </button>
          )}
        </div>
      ))}
      <div className="wl-bar">
        {lanes.length < MAX_LANES && (
          <button className="btn ghost small" onClick={() => setLanes([...lanes, { name: nextName(lanes), message: "" }])}>
            Add lane
          </button>
        )}
        <label className="meta" title={`Each lane lands into one branch, ${slug}, and one PR goes out from there`}>
          <input type="radio" checked={mode === "land"} onChange={() => setMode("land")} /> land into {slug}
        </label>
        <label className="meta" title="Each lane opens its own PR">
          <input type="radio" checked={mode === "pr"} onChange={() => setMode("pr")} /> one PR per lane
        </label>
        <label className="folder base">
          <span className="meta">base</span>
          <input value={base} placeholder="origin's default" onChange={(e) => setBase(e.target.value)} spellCheck={false} />
        </label>
      </div>
    </div>
  );
}

export interface LaneRun {
  tone: string;
  text: string;
  working: boolean;
}

const STATE_LABEL: Partial<Record<WorkLane["state"], { text: string; tone: string }>> = {
  landing: { text: "landing…", tone: "working" },
  landed: { text: "landed", tone: "good" },
  conflict: { text: "conflict", tone: "bad" },
  checks_failed: { text: "checks failed", tone: "bad" },
};

/** One row per lane: its branch, its agent, where its git state stands, and Land. */
export function LanesCard({ ticket, title, lanes, prs, runFor, onError }: { ticket: string; title: string; lanes: WorkLane[]; prs: PullRequest[]; runFor: (sessionId: string) => LaneRun | null; onError: (m: string | null) => void }) {
  const [busy, setBusy] = useState<number | "pr" | null>(null);
  const integration = lanes.find((l) => l.integrationWorktree);
  const prOf = (branch: string | null) => (branch ? prs.find((p) => p.headRef === branch) : undefined);
  const integrationPr = prOf(integration?.integrationBranch ?? null);
  const act = async (which: number | "pr", path: string) => {
    setBusy(which);
    onError(await post(path));
    setBusy(null);
  };
  return (
    <section className="card wl-card">
      <header className="card-head">
        <h3>Parallel lanes · {lanes.length}</h3>
        <span className="meta">
          {integration ? `land into ${integration.integrationBranch} in ${dirLabel(integration.integrationWorktree!)}${integration.integrationAhead ? ` · ${integration.integrationAhead} ahead of origin/${integration.base}` : ""}` : `one PR per lane into ${lanes[0]?.base}`}
        </span>
        <span className="grow" />
        {integrationPr ? (
          <a className="btn ghost small" href={integrationPr.url} target="_blank" rel="noreferrer">
            {prName(integrationPr.url)} ↗
          </a>
        ) : (
          integration && (
            <button
              className="btn small"
              disabled={busy !== null || !integration.integrationAhead || !lanes.some((l) => l.state === "landed")}
              title={`Start an agent in ${integration.integrationWorktree} that pushes ${integration.integrationBranch} and opens the PR into ${integration.base}`}
              onClick={() => act("pr", `/api/lanes/pr?ticket=${encodeURIComponent(ticket)}&title=${encodeURIComponent(title)}`)}
            >
              {busy === "pr" ? "Starting…" : "Open PR"}
            </button>
          )
        )}
      </header>
      <ul className="wl-rows">
        {lanes.map((l) => {
          const run = l.sessionId ? runFor(l.sessionId) : null;
          const g = laneGitText(l);
          const state = STATE_LABEL[l.state];
          const blocker = landBlocker(l, !!run?.working);
          const pr = l.mode === "pr" ? prOf(l.branch) : undefined;
          return (
            <li key={l.id} className="wl-row">
              <div className="wl-line">
                <span className="tag">{l.lane}</span>
                <code className="wl-branch" title={l.worktree}>
                  {l.branch}
                </code>
                <span className={g.warn ? "tone-text-bad" : "meta"}>{g.text}</span>
                {state && <span className={`tag tone-${state.tone}`}>{state.text}</span>}
                {pr && (
                  <a className="meta" href={pr.url} target="_blank" rel="noreferrer">
                    {prName(pr.url)} · {pr.state}
                  </a>
                )}
                <span className="grow" />
                {run ? <span className={`meta tone-text-${run.tone}`}>{run.text}</span> : <span className="meta">starting…</span>}
                {l.sessionId && (
                  <a className="btn ghost small" href={conversationHash(l.sessionId)}>
                    Open
                  </a>
                )}
                {l.mode === "land" && (
                  <button className="btn small" disabled={!!blocker || busy !== null} title={blocker ? `Cannot land: ${blocker}` : `Rebase onto ${l.integrationBranch}, run the checks, and fast-forward ${l.integrationBranch}`} onClick={() => act(l.id, `/api/lanes/land?id=${l.id}`)}>
                    {busy === l.id || l.state === "landing" ? "Landing…" : "Land"}
                  </button>
                )}
                <button
                  className="btn ghost small"
                  disabled={busy !== null || !!run?.working}
                  title={run?.working ? "Its agent is working" : `Remove ${l.worktree}. The branch goes too when its work landed or merged.`}
                  onClick={async () => {
                    setBusy(-l.id);
                    onError(await cleanUp(l.worktree, `lane ${l.lane}'s worktree`));
                    setBusy(null);
                  }}
                >
                  {busy === -l.id ? "Cleaning…" : "Clean up"}
                </button>
              </div>
              {l.note && <p className={`wl-note ${l.state === "conflict" || l.state === "checks_failed" ? "tone-text-bad" : "meta"}`}>{l.note}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Removes a worktree after the server's own fresh check. Resolves to an error message, or null. */
export async function cleanUp(path: string, what: string): Promise<string | null> {
  if (!confirm(`Remove ${what}?\n\n${path}\n\nagent-dash refuses if it has uncommitted files or a live agent, and keeps a branch whose work is not merged.`)) return null;
  const res = await fetch("/api/worktrees/cleanup", { method: "POST", headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  const json = await res.json().catch(() => ({}));
  return res.ok ? null : (json.error ?? `failed (${res.status})`);
}

/** Every worktree of the repos that agent-dash knows, and Clean up for the ones that hold no unsaved work. */
export function WorktreesView({ now }: { now: number }) {
  const [trees, setTrees] = useState<WorktreeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    const res = await fetch("/api/worktrees");
    if (res.ok) setTrees(await res.json());
    else setError(`could not read the worktrees (${res.status})`);
  };
  useEffect(() => {
    load();
  }, []);
  const repos = [...new Set((trees ?? []).map((t) => t.repo))];
  return (
    <article className="workspace worktrees">
      <header className="ws-head">
        <h1>Worktrees</h1>
        <div className="ws-meta">
          <span className="meta">Every git worktree of agent-dash's own repo and of each repo that had a lane. Clean up refuses a worktree with uncommitted files, a live agent, or use in the last 24 hours, and keeps a branch whose work is not on the base or in a merged PR.</span>
        </div>
      </header>
      {!trees && <p className="meta">{error ?? "Reading the worktrees…"}</p>}
      {error && (
        <div className="toast" role="alert">
          {error}
          <button className="btn ghost small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {repos.map((repo) => (
        <div className="card" key={repo}>
          <header className="card-head">
            <h3>{dirLabel(repo)}</h3>
            <span className="meta">{repo}</span>
          </header>
          <ul className="wl-rows">
            {trees!
              .filter((t) => t.repo === repo && t.path !== repo)
              .map((t) => (
                <li key={t.path} className="wl-row">
                  <div className="wl-line">
                    <code className="wl-branch" title={t.path}>
                      {dirLabel(t.path)}
                    </code>
                    <span className="meta nowrap">{t.branch ?? "detached HEAD"}</span>
                    {t.owner ? (
                      <a className="tag" href={`#/t:${t.owner.ticket}`}>
                        {t.owner.ticket}
                        {t.owner.lane ? `/${t.owner.lane}` : " integration"}
                      </a>
                    ) : (
                      <span className="tag tone-muted">orphan</span>
                    )}
                    <span className="grow" />
                    {t.blocker ? (
                      <span className="meta">stays: {t.blocker}</span>
                    ) : (
                      <>
                        <span className="meta">{t.deletesBranch ? "removes the branch too" : t.branch ? `keeps branch ${t.branch}` : ""}</span>
                        <button
                          className="btn small"
                          disabled={busy !== null}
                          onClick={async () => {
                            setBusy(t.path);
                            setError(await cleanUp(t.path, `the worktree ${dirLabel(t.path)}`));
                            await load();
                            setBusy(null);
                          }}
                        >
                          {busy === t.path ? "Cleaning…" : "Clean up"}
                        </button>
                      </>
                    )}
                  </div>
                  <p className="wl-note meta">
                    {t.ahead} ahead · {t.behind} behind origin/{t.base}
                    {t.dirty ? ` · ${t.dirty} uncommitted` : ""}
                    {t.lastUsedAt ? ` · used ${age(t.lastUsedAt, now)} ago` : ""}
                    {t.pr && (
                      <>
                        {" · "}
                        <a href={t.pr.url} target="_blank" rel="noreferrer">
                          {prName(t.pr.url)} {t.pr.state.toLowerCase()}
                        </a>
                      </>
                    )}
                  </p>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </article>
  );
}
