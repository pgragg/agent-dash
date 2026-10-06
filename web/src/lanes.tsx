import { laneGitText, MAX_LANES, type LaneRequest } from "../../shared/lanes.ts";
import type { LaneMode, WorkLane } from "../../shared/types.ts";
import { conversationHash } from "./agents.tsx";
import { dirLabel } from "./lib.tsx";

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
    <div className="lanes-editor">
      {lanes.map((l, i) => (
        <div className="lane-draft" key={i}>
          <input className="lane-name" value={l.name} onChange={(e) => set(i, { name: e.target.value.toLowerCase() })} spellCheck={false} aria-label="Lane name" title={`Branch ${slug}-${l.name}`} />
          <textarea rows={2} value={l.message} placeholder={`What lane ${l.name} does…`} onChange={(e) => set(i, { message: e.target.value })} />
          {lanes.length > 2 && (
            <button className="btn ghost small" onClick={() => setLanes(lanes.filter((_, j) => j !== i))} aria-label={`Remove lane ${l.name}`}>
              ×
            </button>
          )}
        </div>
      ))}
      <div className="lanes-bar">
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
}

/** One row per lane: its branch, its agent, and where its git state stands. */
export function LanesCard({ lanes, runFor }: { lanes: WorkLane[]; runFor: (sessionId: string) => LaneRun | null }) {
  const integration = lanes.find((l) => l.integrationWorktree);
  return (
    <section className="card lanes">
      <header className="card-head">
        <h3>Parallel lanes · {lanes.length}</h3>
        <span className="meta">{integration ? `land into ${integration.integrationBranch} in ${dirLabel(integration.integrationWorktree!)}` : `one PR per lane into ${lanes[0]?.base}`}</span>
      </header>
      <ul className="lane-rows">
        {lanes.map((l) => {
          const run = l.sessionId ? runFor(l.sessionId) : null;
          const g = laneGitText(l);
          return (
            <li key={l.id} className="lane-row">
              <span className="tag">{l.lane}</span>
              <code className="lane-branch" title={l.worktree}>
                {l.branch}
              </code>
              <span className={g.warn ? "tone-text-bad" : "meta"}>{g.text}</span>
              <span className="grow" />
              {run ? (
                <span className={`meta tone-text-${run.tone}`}>{run.text}</span>
              ) : (
                <span className="meta">starting…</span>
              )}
              {l.sessionId && (
                <a className="btn ghost small" href={conversationHash(l.sessionId)}>
                  Open
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
