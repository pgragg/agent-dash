import { useEffect, useRef, useState } from "react";
import { activityParts } from "../../shared/activity.ts";
import type { HistoryRun, Run, RunDialog } from "../../shared/types.ts";
import { age, api, dirLabel, post } from "./lib.tsx";

/**
 * Live control of a running agent from the page: what it does now, Stop, Steer, and the
 * answer to an extension dialog. Each one removes a reason to open the iTerm tab.
 */

const q = (sessionId: string) => `session=${encodeURIComponent(sessionId)}`;

const controlApi = {
  stop: (sessionId: string) => post(`/api/stop?${q(sessionId)}`),
  answer: (sessionId: string, answer: { value: string } | { confirmed: boolean } | { cancelled: true }) => post(`/api/dialog?${q(sessionId)}`, answer),
};

/** The tool that runs now, and an open dialog. `working` shows while the agent works with no tool. */
export function LivePanel({ run, now, onError, working }: { run: Run; now: number; onError: (m: string | null) => void; working?: string }) {
  const a = run.status === "working" ? run.activity : null;
  const p = a ? activityParts(a, now) : null;
  return (
    <>
      {p ? (
        <p className="activity meta">
          {p.verb} {p.code && <code>{p.code}</code>} · {p.elapsed}
        </p>
      ) : (
        run.status === "working" && working && <p className="meta">{working}</p>
      )}
      {run.dialog && <DialogCard key={run.dialog.since} run={run} dialog={run.dialog} now={now} onError={onError} />}
    </>
  );
}

function DialogCard({ run, dialog, now, onError }: { run: Run; dialog: RunDialog; now: number; onError: (m: string | null) => void }) {
  const [text, setText] = useState(dialog.prefill ?? "");
  const [sending, setSending] = useState(false);
  const answer = async (a: Parameters<typeof controlApi.answer>[1]) => {
    setSending(true);
    const err = await controlApi.answer(run.sessionId, a);
    onError(err);
    // On success the dialog closes in the status file and this card goes away; if not, allow a retry.
    if (err) setSending(false);
    else setTimeout(() => setSending(false), 5_000);
  };
  return (
    <div className="dialog-card">
      <div className="dialog-head">
        <strong>{dialog.title || "The agent asks"}</strong>
        <span className="meta">dialog · open {age(dialog.since, now)}</span>
      </div>
      {dialog.message && <p className="dialog-message">{dialog.message}</p>}
      {!run.headless ? (
        <p className="meta">Waiting on a dialog in iTerm. Answer it in the session's tab.</p>
      ) : (
        <div className="dialog-actions">
          {dialog.method === "select" &&
            (dialog.options ?? []).map((o) => (
              <button key={o} className="btn small" disabled={sending} onClick={() => answer({ value: o })}>
                {o}
              </button>
            ))}
          {dialog.method === "confirm" && (
            <>
              <button className="btn small primary" disabled={sending} onClick={() => answer({ confirmed: true })}>
                Yes
              </button>
              <button className="btn small" disabled={sending} onClick={() => answer({ confirmed: false })}>
                No
              </button>
            </>
          )}
          {(dialog.method === "input" || dialog.method === "editor") && (
            <>
              <textarea rows={dialog.method === "editor" ? 6 : 2} value={text} placeholder={dialog.placeholder} onChange={(e) => setText(e.target.value)} />
              <button className="btn small primary" disabled={sending} onClick={() => answer({ value: text })}>
                Send
              </button>
            </>
          )}
          <button className="btn small ghost" disabled={sending} onClick={() => answer({ cancelled: true })}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export function Composer({ run, onError, focusSignal }: { run: HistoryRun; onError: (m: string | null) => void; focusSignal: number }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [steer, setSteer] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusSignal) ref.current?.focus();
  }, [focusSignal]);
  const working = run.status === "working";
  const controls = working && Boolean(run.canControl);
  // An open dialog makes the run wait for you, but Stop is still the way out of it.
  const stoppable = Boolean(run.canControl) && (working || Boolean(run.dialog));
  const steering = controls && steer;
  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    const err = await api.reply(run.sessionId, text, steering);
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
        placeholder={steering ? "Steer the agent: it reads this after the current tool calls…" : working ? "Queue a message for when the agent finishes…" : "Reply to the agent…"}
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
        <span className="composer-actions">
          {controls && (
            <span className="seg" role="radiogroup" aria-label="When the agent reads it">
              <button role="radio" aria-checked={!steer} className={`btn small ${steer ? "ghost" : ""}`} onClick={() => setSteer(false)} title="Deliver when the agent finishes (follow-up)">
                Send after it finishes
              </button>
              <button role="radio" aria-checked={steer} className={`btn small ${steer ? "" : "ghost"}`} onClick={() => setSteer(true)} title="Deliver after the current tool calls, before the next model call">
                Steer now
              </button>
            </span>
          )}
          {stoppable && (
            <button className="btn small" onClick={async () => onError(await controlApi.stop(run.sessionId))} title="Stop the current agent run, as Esc does">
              Stop
            </button>
          )}
          {working && !run.canControl && <span className="meta">{run.headless ? "Stop and Steer need a newer agent-dash extension." : "Type /reload in the session for Stop and Steer."}</span>}
          <button className="btn primary" onClick={send} disabled={sending || !text.trim()}>
            {sending ? "Sending…" : steering ? "Steer" : working ? "Queue" : "Send"} <kbd>⌘↵</kbd>
          </button>
        </span>
      </div>
    </div>
  );
}
