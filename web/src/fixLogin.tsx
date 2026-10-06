import { useState } from "react";
import type { Dashboard } from "../../shared/types.ts";

/** Sources whose login `pi-auth ensure` can refresh; the server keeps the same fixed list. */
const FIXABLE: Record<string, string> = { jira: "Jira", github: "GitHub" };

/** A "Fix login" button for each down source. It runs pi-auth on the server, then refreshes. */
export function FixLogin({ sources, onFixed }: { sources: Dashboard["sources"]; onFixed: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});
  const down = Object.entries(sources).filter(([name, h]) => !h.ok && FIXABLE[name]);
  if (!down.length) return null;
  const fix = async (name: string) => {
    setBusy(name);
    try {
      const res = await fetch(`/api/login?source=${encodeURIComponent(name)}`, { method: "POST", headers: { "X-Agent-Dash": "1" } });
      const body = await res.json().catch(() => ({}));
      setResult((r) => ({ ...r, [name]: res.ok ? "ok" : (body.error ?? `failed (${res.status})`) }));
      if (res.ok) onFixed();
    } catch (err) {
      setResult((r) => ({ ...r, [name]: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };
  const shown = Object.entries(result).find(([, m]) => m);
  return (
    <>
      {down.map(([name]) => (
        <button key={name} className="btn small" disabled={busy !== null} onClick={() => fix(name)} title={`Run pi-auth ensure for ${FIXABLE[name]}. It can open Chrome.`}>
          {busy === name ? `Logging in to ${FIXABLE[name]}… (can take minutes)` : `Fix ${FIXABLE[name]} login`}
        </button>
      ))}
      {shown && (
        <div className={`toast login-toast ${shown[1] === "ok" ? "success" : ""}`} role="alert">
          {FIXABLE[shown[0]]} login: {shown[1] === "ok" ? "✓ logged in" : shown[1]}
          <button className="btn ghost small" onClick={() => setResult((r) => ({ ...r, [shown[0]]: "" }))}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
