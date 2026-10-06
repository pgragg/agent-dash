import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, SETTING_FIELDS, type SettingField, type SettingKey, type Settings, type SettingsState } from "../../shared/settings.ts";
import { AGENT_LABEL, type AgentKind, team } from "../../shared/team.ts";

/** A list shows as "A, B" in its box; the server splits it again. */
const toText = (f: SettingField, v: Settings[SettingKey]): string => (Array.isArray(v) ? v.join(", ") : String(v));

const GROUPS = [...new Set(SETTING_FIELDS.map((f) => f.group))];

const DISMISSED = "agent-dash.setup-dismissed";

/**
 * "Set it up for me": pick the agent, then a headless agent finds the settings and saves them.
 * The click on Start is the user's permission; the page then opens the agent's conversation.
 */
export function SetupAgent({ onCancel }: { onCancel: () => void }) {
  const [agent, setAgent] = useState<AgentKind>(team.agent);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/setup", { method: "POST", headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: JSON.stringify({ agent }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `could not start the setup agent (${res.status})`);
      location.hash = `#/c:${encodeURIComponent(body.sessionId)}`;
      onCancel();
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  };
  return (
    <div className="setup-agent" role="dialog" aria-label="Set up agent-dash">
      <div className="setup-agent-row">
        <span className="setting-label">1. Your agent</span>
        <span className="seg" role="radiogroup" aria-label="Agent">
          {(Object.keys(AGENT_LABEL) as AgentKind[]).map((a) => (
            <button key={a} role="radio" aria-checked={agent === a} className={`btn small ${agent === a ? "" : "ghost"}`} onClick={() => setAgent(a)}>
              {AGENT_LABEL[a]}
            </button>
          ))}
        </span>
      </div>
      <p className="meta">
        2. agent-dash saves {AGENT_LABEL[agent]} as your agent, {agent === "pi" ? "links its status extension into pi, " : ""}and starts {AGENT_LABEL[agent]} on this page. It looks for each setting on this machine with read-only commands (git config, gh, ls, grep), saves what it finds with the same checks as the Settings page, and asks you for the rest. It never prints your Jira token.
        {agent === "claude" ? " Claude Code asks you on the page before each command." : ""} Then restart agent-dash.
      </p>
      {error && <p className="setting-error">{error}</p>}
      <div className="setup-agent-row">
        <button className="btn small" disabled={starting} onClick={start}>
          {starting ? "Starting…" : `Start ${AGENT_LABEL[agent]}`}
        </button>
        <button className="btn ghost small" disabled={starting} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Until the settings are set, every view says what is missing, instead of a red "Jira down". */
export function SetupBanner({ setup }: { setup: string[] }) {
  // Dismissed for this exact list, so a newly missing setting shows again.
  const key = setup.join(",");
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED));
  const [picking, setPicking] = useState(false);
  if (!setup.length || dismissed === key) return null;
  const list = setup.length > 1 ? `${setup.slice(0, -1).join(", ")} and ${setup.at(-1)}` : setup[0];
  return (
    <div className="setup-banner" role="status">
      <div className="setup-banner-row">
        <span>
          agent-dash is not set up yet. Set {list} on the <a href="#/settings">Settings</a> page, then restart agent-dash.
        </span>
        <span className="setup-banner-actions">
          {!picking && (
            <button className="btn small" onClick={() => setPicking(true)}>
              Set it up for me
            </button>
          )}
          <button
            className="btn ghost small"
            onClick={() => {
              localStorage.setItem(DISMISSED, key);
              setDismissed(key);
            }}
          >
            Dismiss
          </button>
        </span>
      </div>
      {picking && <SetupAgent onCancel={() => setPicking(false)} />}
    </div>
  );
}

/** `` `code` `` spans in a how-to-find text, as code. */
const withCode = (text: string) => text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

/** The example value and where to find it, under a field's help. */
function FieldGuide({ f }: { f: SettingField }) {
  return (
    <span className="meta setting-guide">
      Example: <code>{f.example}</code>. How to find it: {withCode(f.find)}
    </span>
  );
}

/** `#/settings`: edit agent-dash.config.json. The server runs with the new values after a restart. */
export function SettingsView() {
  const [state, setState] = useState<SettingsState | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Partial<Record<SettingKey, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [picking, setPicking] = useState(false);

  const load = (s: SettingsState) => {
    setState(s);
    setDraft(Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, toText(f, s.saved[f.key])])));
  };
  useEffect(() => {
    fetch("/api/settings")
      .then(async (res) => (res.ok ? load(await res.json()) : setError(`could not read the settings (${res.status})`)))
      .catch((err: Error) => setError(err.message));
  }, []);

  const dirty = !!state && SETTING_FIELDS.some((f) => draft[f.key] !== toText(f, state.saved[f.key]));
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", { method: "POST", headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      const body = await res.json().catch(() => ({}));
      setErrors(body.errors ?? {});
      if (!res.ok) return setError(body.error ?? `could not save (${res.status})`);
      load(body);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="workspace settings">
      <header className="ws-head">
        <h1>Settings</h1>
        <div className="ws-meta">
          <span className="meta">
            Your own paths and accounts. They are saved in <code>{state?.file ?? "agent-dash.config.json"}</code>, which git ignores{state && !state.exists ? " (it does not exist yet: Save makes it)" : ""}. A path can start with <code>~/</code>.
          </span>
          {state && !state.readOnly && !picking && (
            <button className="btn ghost small" onClick={() => setPicking(true)} title="An agent finds these values on this machine and saves them">
              Set it up for me
            </button>
          )}
        </div>
      </header>
      {picking && <SetupAgent onCancel={() => setPicking(false)} />}
      {!state && !error && <p className="meta">Reading the settings…</p>}
      {state?.readOnly && (
        <div className="toast settings-note" role="status">
          This server runs in a worktree, so it uses the main checkout's settings. Change them from the main checkout's server.
        </div>
      )}
      {state && state.saved.ticketProviders.length > 0 && (
        <div className="toast settings-note" role="status">
          The file's <code>ticketProviders</code> list sets the ticket trackers ({state.saved.ticketProviders.map((p) => (p.type === "jira" ? `Jira at ${p.server || "no server"}` : `${p.prefix} files`)).join(", ")}), so the Jira fields and the local tickets folder below are not used. Edit the list in the file.
        </div>
      )}
      {state?.restartNeeded && (
        <div className="toast settings-note" role="status">
          {saved ? "Saved. " : ""}The server still runs with the old values. Restart agent-dash to use the saved ones.
        </div>
      )}
      {error && (
        <div className="toast" role="alert">
          {error}
          <button className="btn ghost small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {state &&
        GROUPS.map((group) => (
          <div className="card" key={group}>
            <header className="card-head">
              <h3>{group}</h3>
            </header>
            {SETTING_FIELDS.filter((f) => f.group === group).map((f) => {
              const env = state.envOverrides[f.key];
              const change = (value: string) => {
                setSaved(false);
                setDraft((d) => ({ ...d, [f.key]: value }));
              };
              if (f.kind === "choice") {
                return (
                  <div className="setting" key={f.key}>
                    <span className="setting-label">{f.label}</span>
                    <span className="seg" role="radiogroup" aria-label={f.label}>
                      {f.options!.map((o) => (
                        <button key={o.value} role="radio" aria-checked={draft[f.key] === o.value} className={`btn small ${draft[f.key] === o.value ? "" : "ghost"}`} disabled={state.readOnly} onClick={() => change(o.value)}>
                          {o.label}
                        </button>
                      ))}
                    </span>
                    <span className="meta">
                      {errors[f.key] ? <b className="setting-error">{errors[f.key]}. </b> : null}
                      {withCode(f.help)}
                      {env ? <b> {env} is set, and wins over this value.</b> : null}
                    </span>
                    <FieldGuide f={f} />
                  </div>
                );
              }
              return (
                <label className="setting" key={f.key}>
                  <span className="setting-label">{f.label}</span>
                  <input
                    type={f.kind === "number" ? "number" : "text"}
                    value={draft[f.key] ?? ""}
                    placeholder={toText(f, DEFAULT_SETTINGS[f.key]) || "(not set)"}
                    spellCheck={false}
                    readOnly={state.readOnly}
                    aria-invalid={!!errors[f.key]}
                    onChange={(e) => change(e.target.value)}
                  />
                  <span className="meta">
                    {errors[f.key] ? <b className="setting-error">{errors[f.key]}. </b> : null}
                    {withCode(f.help)}
                    {f.kind === "list" ? " Separate them with commas." : ""}
                    {env ? <b> {env} is set, and wins over this value.</b> : null}
                  </span>
                  <FieldGuide f={f} />
                </label>
              );
            })}
          </div>
        ))}
      {state && !state.readOnly && (
        <div className="settings-bar">
          <button className="btn" disabled={saving || !dirty} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="btn ghost" disabled={saving || !dirty} onClick={() => load(state)}>
            Discard changes
          </button>
        </div>
      )}
    </article>
  );
}
