import { Fragment, type ReactNode, useCallback, useEffect, useState } from "react";
import type { Dashboard, Run } from "../../shared/types.ts";

// ---- time ---------------------------------------------------------------------------

/** "45s", "12m", "3h", "4d", "2w". */
export function age(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 14 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / (7 * 86_400))}w`;
}

/** "1m 12s" for a timer that counts up. */
export function elapsed(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric" });
}

/** "17d overdue", "due today", "due in 4d". */
export function dueLabel(due: string | null): { text: string; tone: "bad" | "warn" | "muted" } | null {
  if (!due) return null;
  const today = new Date(new Date().toISOString().slice(0, 10));
  const days = Math.round((Date.parse(due) - today.getTime()) / 86_400_000);
  if (days < 0) return { text: `${-days}d overdue`, tone: "bad" };
  if (days === 0) return { text: "due today", tone: "warn" };
  return { text: `due in ${days}d`, tone: days <= 3 ? "warn" : "muted" };
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ---- names --------------------------------------------------------------------------

export function prName(url: string): string {
  const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : url;
}

export function dirLabel(cwd: string): string {
  if (/^\/Users\/[^/]+\/?$/.test(cwd)) return "~";
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

export function runTitle(run: Run): string {
  return run.name ?? run.firstPrompt;
}

export function resumeCommand(run: Run): string {
  return `cd '${run.cwd.replace(/'/g, "'\\''")}' && pi --session ${run.sessionId}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---- data ---------------------------------------------------------------------------

export function useDashboard() {
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

/** The custom header makes the browser send a CORS preflight, which the server never answers. */
async function post(path: string, body?: unknown): Promise<string | null> {
  const res = await fetch(path, { method: "POST", headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (res.ok) return null;
  const json = await res.json().catch(() => ({}));
  return json.error ?? json.detail ?? FOCUS_ERRORS[json.result] ?? `failed (${res.status})`;
}

const FOCUS_ERRORS: Record<string, string> = {
  missing: "The tab is gone. Copy the resume command instead.",
  not_authorized: "Allow it in System Settings → Privacy & Security → Automation → iTerm2.",
};

export const api = {
  focusTab: (sessionId: string) => post(`/api/focus?session=${encodeURIComponent(sessionId)}`),
  summarize: (ticket: string, force: boolean) => post(`/api/summaries?ticket=${encodeURIComponent(ticket)}${force ? "&force" : ""}`),
  reply: (sessionId: string, text: string) => post(`/api/reply?session=${encodeURIComponent(sessionId)}`, { text }),
};

// ---- markdown -----------------------------------------------------------------------

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s)<>\]]+)/g;
const JIRA = /atlassian\.net\/browse\/([A-Z]+-\d+)/;

function linkLabel(url: string): string {
  if (/github\.com\/.+\/pull\/\d+/.test(url)) return prName(url);
  const jira = url.match(JIRA);
  return jira ? jira[1] : url.replace(/^https?:\/\//, "");
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [tok] = m;
    if (m[1]) out.push(<code key={m.index}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={m.index}>{inline(tok.slice(2, -2))}</strong>);
    else if (m[3]) {
      const [, label, url] = tok.match(/^\[([^\]]+)\]\((.+)\)$/)!;
      out.push(<a key={m.index} href={url} target="_blank" rel="noreferrer">{label}</a>);
    } else {
      out.push(<a key={m.index} href={tok} target="_blank" rel="noreferrer" title={tok}>{linkLabel(tok)}</a>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Enough markdown for agent replies: paragraphs, lists, headings, fences, tables, and
 * inline code, bold and links. React escapes all text, so a reply cannot inject HTML.
 */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (line.startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      blocks.push(<pre key={i}>{body.join("\n")}</pre>);
    } else if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].trim().startsWith("|"); i++) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue;
        rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      }
      blocks.push(
        <div className="md-table" key={i}>
          <table>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => (ri === 0 ? <th key={ci}>{inline(c)}</th> : <td key={ci}>{inline(c)}</td>))}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h4 key={i}>{inline(line.replace(/^#+\s*/, ""))}</h4>);
      i++;
    } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={i}>{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</List>);
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*\||\s*([-*•]|\d+[.)])\s+)/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(
        <p key={i}>
          {para.map((p, k) => (
            <Fragment key={k}>
              {k > 0 && <br />}
              {inline(p)}
            </Fragment>
          ))}
        </p>,
      );
    }
  }
  return <div className="md">{blocks}</div>;
}
