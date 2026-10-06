import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, SETTING_FIELDS, type SettingField, type SettingKey, type Settings, type SettingsState } from "../../shared/settings.ts";

/** A list shows as "A, B" in its box; the server splits it again. */
const toText = (f: SettingField, v: Settings[SettingKey]): string => (Array.isArray(v) ? v.join(", ") : String(v));

const GROUPS = [...new Set(SETTING_FIELDS.map((f) => f.group))];

const DISMISSED = "agent-dash.setup-dismissed";

/** Until the settings are set, every view says what is missing, instead of a red "Jira down". */
export function SetupBanner({ setup }: { setup: string[] }) {
  // Dismissed for this exact list, so a newly missing setting shows again.
  const key = setup.join(",");
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED));
  if (!setup.length || dismissed === key) return null;
  const list = setup.length > 1 ? `${setup.slice(0, -1).join(", ")} and ${setup.at(-1)}` : setup[0];
  return (
    <div className="setup-banner" role="status">
      <span>
        agent-dash is not set up yet. Set {list} on the <a href="#/settings">Settings</a> page, then restart agent-dash.
      </span>
      <button
        className="btn ghost small"
        onClick={() => {
          localStorage.setItem(DISMISSED, key);
          setDismissed(key);
        }}
      >
        Dismiss
      </button>
    </div>
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
        </div>
      </header>
      {!state && !error && <p className="meta">Reading the settings…</p>}
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
              return (
                <label className="setting" key={f.key}>
                  <span className="setting-label">{f.label}</span>
                  <input
                    type={f.kind === "number" ? "number" : "text"}
                    value={draft[f.key] ?? ""}
                    placeholder={toText(f, DEFAULT_SETTINGS[f.key]) || "(not set)"}
                    spellCheck={false}
                    aria-invalid={!!errors[f.key]}
                    onChange={(e) => {
                      setSaved(false);
                      setDraft((d) => ({ ...d, [f.key]: e.target.value }));
                    }}
                  />
                  <span className="meta">
                    {errors[f.key] ? <b className="setting-error">{errors[f.key]}. </b> : null}
                    {f.help}
                    {f.kind === "list" ? " Separate them with commas." : ""}
                    {env ? <b> {env} is set, and wins over this value.</b> : null}
                  </span>
                </label>
              );
            })}
          </div>
        ))}
      {state && (
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
