import { useEffect, useState } from "react";
import type { Turn } from "../../shared/types.ts";
import { api, Markdown, plural, stamp } from "./lib.tsx";
import { SessionScope } from "./mermaid.tsx";

/** A pi session's prompts and replies, from its log. In App's views and under a smoketest plan. */

/** Turns shown when a chat opens. The newest are kept, because that is where the chat stopped. */
const TURNS_SHOWN = 40;

/** Loads again whenever the key changes, which the page passes as the dashboard's last update. */
export function useLoad<T>(load: () => Promise<T>, key: unknown): { value: T | null; error: string | null } {
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

/** `firstPrompt` closes the first message: agent-dash wrote it for the agent, not for Piper. */
export function Chat({ sessionId, refreshKey, firstPrompt }: { sessionId: string; refreshKey: unknown; firstPrompt?: string }) {
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
        {shown.map((t, i) =>
          firstPrompt && t.role === "user" && turns.length === shown.length && i === 0 ? (
            <details key={0} className="smoke-results chat-prompt">
              <summary>{firstPrompt}</summary>
              <Markdown text={t.text} />
            </details>
          ) : (
            <div key={turns.length - shown.length + i} className={`turn ${t.role}`}>
              <div className="turn-head">
                <b>{t.role === "user" ? "You" : "Agent"}</b>
                {t.at && <span className="meta">{stamp(t.at)}</span>}
              </div>
              <Markdown text={t.text} />
            </div>
          ),
        )}
      </div>
    </SessionScope>
  );
}
