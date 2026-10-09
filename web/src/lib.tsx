import { Fragment, type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { runTitle } from "../../shared/runTitle.ts";
import type { Dashboard, HistoryRun, TicketDocumentWithBody, PrDetail, ThreadStatus, Transcript } from "../../shared/types.ts";
import { setTeam } from "../../shared/team.ts";
import { IMAGE_EXT, wikiLinkParts } from "../../shared/wiki.ts";
import { href } from "./routes.ts";
import { dashClick, internalHref, JIRA_BROWSE, splitTrailing } from "./links.ts";
import { EmbeddedImage, MermaidFence, setKnownDiagrams } from "./mermaid.tsx";
import { addUpdate, entryOf, entryOfSignal, type Group, groupNotification, needSignals, newlyWaiting, newSignals, type Pending, pruneSeen, releasePending, runsOf, runUpdate, type Seen, type SeenAt, signalUpdate, snapshot, type Update } from "./notify.ts";

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

/** "Oct 2, 2:31 PM". */
export function stamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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

/**
 * Scrolls to the element whose DOM id is the ref, and flashes it. A history row's id has an
 * "h:" prefix, so the agent card of a live run wins over its row in the history.
 */
export function useFlash(anchor: string | null) {
  useEffect(() => {
    if (!anchor) return;
    // After the children's own effects, such as a history list that opens to show the row.
    const t = setTimeout(() => {
      const el = document.getElementById(anchor) ?? document.getElementById(`h:${anchor}`);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.classList.remove("flash");
      void el.offsetWidth; // Restarts the animation when the same element flashes again.
      el.classList.add("flash");
    }, 60);
    return () => clearTimeout(t);
  }, [anchor]);
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

export { runTitle } from "../../shared/runTitle.ts";

export function resumeCommand(run: HistoryRun): string {
  const cd = `cd '${run.cwd.replace(/'/g, "'\\''")}' && `;
  if (run.agent === "opencode") return `${cd}opencode --session ${run.sessionId}`;
  return run.agent === "claude" ? `${cd}claude --resume ${run.sessionId}` : `${cd}pi --session ${run.sessionId}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---- data ---------------------------------------------------------------------------

/** Ticket keys on the board, so a Jira link in a message can open the ticket here. */
let knownTickets: ReadonlySet<string> = new Set();

/**
 * Reloads the page to get the newest build, but not over typed text, and at most once a minute.
 * A tab from before a rebuild runs old code: it cannot lazy-load the deleted chunks, and it shows
 * new kinds of data (a ticket brief's JSON spec) the old way.
 */
export function reloadForNewBuild(): boolean {
  const typed = [...document.querySelectorAll("textarea")].some((t) => t.value.trim());
  const last = Number(sessionStorage.getItem("agent-dash:chunk-reload") ?? 0);
  if (typed || Date.now() - last < 60_000) return false;
  sessionStorage.setItem("agent-dash:chunk-reload", String(Date.now()));
  location.reload();
  return true;
}

/** The entry script of the build that this tab runs; empty under `pnpm dev`. */
const ownBuild = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.getAttribute("src") ?? "";

export function useDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const sent = useRef(0);
  const applied = useRef(0);
  const load = useCallback(async (refresh = false) => {
    // Loads overlap when changes come fast; a slow, older answer must not overwrite a newer one.
    const seq = ++sent.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard${refresh ? "?refresh" : ""}`);
      if (!res.ok) throw new Error(await res.text());
      const build = res.headers.get("x-agent-dash-build");
      if (ownBuild && build && build !== ownBuild && reloadForNewBuild()) return;
      const body: Dashboard = await res.json();
      if (seq < applied.current) return;
      applied.current = seq;
      // Before setData: shared code reads the team settings while the page renders.
      if (body.team) setTeam(body.team);
      knownTickets = new Set([...body.myTickets, ...body.otherTickets].map((g) => g.ticket.key));
      setKnownDiagrams(body.diagrams, body.documents);
      setData(body);
      setError(null);
    } catch (err) {
      if (seq >= applied.current) setError((err as Error).message);
    } finally {
      if (seq === sent.current) setLoading(false);
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

// ---- notifications ------------------------------------------------------------------

const MUTE_KEY = "agent-dash:notifications-muted";

export type NotifyState = "unsupported" | "ask" | "on" | "muted" | "blocked";

/** True while this tab is visible and has the focus: only then do you look at the page. */
export function usePageFocus(): boolean {
  const read = () => document.visibilityState === "visible" && document.hasFocus();
  const [focused, setFocused] = useState(read);
  useEffect(() => {
    const update = () => setFocused(read());
    for (const e of ["focus", "blur"]) window.addEventListener(e, update);
    document.addEventListener("visibilitychange", update);
    return () => {
      for (const e of ["focus", "blur"]) window.removeEventListener(e, update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return focused;
}

const SEEN_KEY = "agent-dash:seen";

function readSeenAll(): SeenAt {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as SeenAt;
  } catch {
    return {};
  }
}

/** When you last looked at a board entry, or null if you never did. */
export function lastSeen(id: string): string | null {
  return readSeenAll()[id] ?? null;
}

function markSeen(id: string) {
  const now = Date.now();
  localStorage.setItem(SEEN_KEY, JSON.stringify({ ...pruneSeen(readSeenAll(), now), [id]: new Date(now).toISOString() }));
}

/**
 * Records that you look at a board entry, while you do. Returns your look before this one, so the
 * page can mark what came after it. It stays when you leave the tab, and is read again when you
 * come back, so what came while you were away is new.
 */
export function useLook(id: string | null): { id: string; lastLook: string | null } | null {
  // Read at render, before the effect marks the look: StrictMode runs an effect twice in dev.
  const prev = useRef<string | null>(null);
  const look = useRef<{ id: string; lastLook: string | null } | null>(null);
  if (id !== prev.current) {
    prev.current = id;
    if (id) look.current = { id, lastLook: lastSeen(id) };
  }
  useEffect(() => {
    if (!id) return;
    const mark = () => markSeen(id);
    mark();
    const timer = setInterval(mark, 5000);
    return () => {
      clearInterval(timer);
      mark();
    };
  }, [id]);
  return look.current;
}

/** The notification's heading: the ticket key and title, else the run or PR. */
function entryLabel(d: Dashboard, id: string): string {
  if (id.startsWith("t:")) {
    const key = id.slice(2);
    const g = [...d.myTickets, ...d.otherTickets].find((x) => x.ticket.key === key);
    return g ? `${key} · ${g.ticket.summary}` : key;
  }
  if (id.startsWith("r:")) {
    const r = runsOf(d).find((x) => x.sessionId === id.slice(2));
    return r ? runTitle(r) : "Agent";
  }
  return prName(id.slice(2));
}

/**
 * Browser notifications, one per board entry: a ticket, else the run or PR with no ticket. They
 * come when an agent stops, or when a new signal on the entry needs you. They replace the pi
 * extension that asked macOS for a notification, so they fire only while this page is open.
 * `looking` is the entry that you look at now: it gets no notification, and looking clears it.
 */
export function useWaitNotifications(data: Dashboard | null, looking: string | null) {
  const supported = typeof Notification !== "undefined";
  const [permission, setPermission] = useState(supported ? Notification.permission : "denied");
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === "1");
  const seen = useRef<Map<string, Seen> | null>(null);
  const signals = useRef<ReturnType<typeof needSignals> | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const groups = useRef(new Map<string, Group>());
  const shown = useRef(new Map<string, Notification>());
  const latest = useRef(data);
  const lookingRef = useRef(looking);
  lookingRef.current = looking;

  const notify = useCallback(
    (d: Dashboard, id: string, u: Update) => {
      if (id === lookingRef.current) return;
      // A snoozed ticket is off the board until its time, so it stays quiet too.
      const until = id.startsWith("t:") ? d.snoozedUntil[id.slice(2)] : undefined;
      if (until && Date.parse(until) > Date.now()) return;
      const { group, alert } = addUpdate(groups.current, id, entryLabel(d, id), u);
      if (!supported || muted || Notification.permission !== "granted") return;
      const { title, body } = groupNotification(group);
      // The tag makes this replace the entry's earlier notification, also one from a second dash tab.
      const n = new Notification(title, { body, tag: id, silent: !alert, renotify: false } as NotificationOptions);
      shown.current.set(id, n);
      n.onclick = () => {
        window.focus();
        location.hash = `#/${encodeURIComponent(id)}`;
        n.close();
      };
    },
    [muted, supported],
  );

  const release = useCallback(() => {
    const d = latest.current;
    if (!d) return;
    const { send, keep } = releasePending(pending.current, runsOf(d), d.conversationSummaries, Date.now());
    pending.current = keep;
    for (const r of send) notify(d, entryOf(r), runUpdate(r, d.conversationSummaries[r.sessionId]));
  }, [notify]);

  useEffect(() => {
    if (!data) return;
    latest.current = data;
    const runs = runsOf(data);
    for (const r of newlyWaiting(seen.current, runs)) pending.current.set(r.sessionId, { since: r.statusSince, heldAt: Date.now() });
    seen.current = snapshot(runs);
    const now = needSignals(data.attention);
    for (const a of newSignals(signals.current, now)) notify(data, entryOfSignal(a), signalUpdate(a));
    signals.current = now;
    release();
  }, [data, release, notify]);

  // The time limit passes with no new data, so check it on a timer too.
  useEffect(() => {
    const id = setInterval(release, 5000);
    return () => clearInterval(id);
  }, [release]);

  // You looked at the entry: its updates are read, and its notification goes.
  useEffect(() => {
    if (!looking) return;
    groups.current.delete(looking);
    shown.current.get(looking)?.close();
    shown.current.delete(looking);
  }, [looking]);

  const state: NotifyState = !supported ? "unsupported" : permission === "denied" ? "blocked" : permission === "default" ? "ask" : muted ? "muted" : "on";
  const setMute = (m: boolean) => {
    setMuted(m);
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  };
  return {
    state,
    /** Must run from a click: browsers ask for permission only after a user gesture. */
    enable: async () => {
      if (!supported) return;
      const p = await Notification.requestPermission();
      setPermission(p);
      if (p !== "granted") return;
      setMute(false);
      new Notification("agent-dash notifications are on", { body: "You get one per ticket when something on it needs you.", tag: "agent-dash-test" });
    },
    mute: () => setMute(true),
  };
}

/** The custom header makes the browser send a CORS preflight, which the server never answers. */
export async function post(path: string, body?: unknown, method = "POST"): Promise<string | null> {
  const res = await fetch(path, { method, headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
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
  /** Drafts a finished run's short summary, if it has none or an old one. */
  summarizeConversation: (sessionId: string) => post(`/api/conversation-summaries?session=${encodeURIComponent(sessionId)}`),
  summarize: (ticket: string, force: boolean) => post(`/api/summaries?ticket=${encodeURIComponent(ticket)}${force ? "&force" : ""}`),
  /** A steer goes in after the current tool calls; a plain reply waits until the agent finishes. */
  reply: (sessionId: string, text: string, steer = false) => post(`/api/reply?session=${encodeURIComponent(sessionId)}`, { text, steer }),
  addNote: (ticket: string, body: string) => post(`/api/notes?ticket=${encodeURIComponent(ticket)}`, { body }),
  deleteNote: (id: number) => post(`/api/notes?id=${id}`, undefined, "DELETE"),
  /** `until` null wakes the ticket. */
  snooze: (ticket: string, until: string | null) => post(`/api/snooze?ticket=${encodeURIComponent(ticket)}`, { until }),
  star: (ticket: string, starred: boolean) => post(`/api/star?ticket=${encodeURIComponent(ticket)}`, { starred }),
  /** Starts a headless pi with the first message; resolves to its session id, or throws the reason. */
  newConversation: async (message: string, cwd: string): Promise<string> => {
    const res = await fetch("/api/conversations", { method: "POST", headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: JSON.stringify({ message, cwd }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `failed (${res.status})`);
    return json.sessionId;
  },
  endConversation: (sessionId: string) => post(`/api/conversations/end?session=${encodeURIComponent(sessionId)}`),
  /** `from` is the due date the page showed; the server refuses if the tracker holds another one. */
  setDueDate: (ticket: string, date: string, from: string | null) => post(`/api/ticket/due?key=${encodeURIComponent(ticket)}`, { date, from }),
  moveTicket: (ticket: string, to: string, from: string) => post(`/api/ticket/move?key=${encodeURIComponent(ticket)}`, { to, from }),
  startAgent: (ticket: string, message: string, cwd: string) => post(`/api/agents?ticket=${encodeURIComponent(ticket)}`, { message, cwd }),
  /** The server writes the first message from the stored step. */
  startStep: (ticket: string, step: number, cwd: string) => post(`/api/agents?ticket=${encodeURIComponent(ticket)}`, { step, cwd }),
  agentContext: async (ticket: string): Promise<string> => {
    const res = await fetch(`/api/agents/context?ticket=${encodeURIComponent(ticket)}`, { headers: { "X-Agent-Dash": "1" } });
    return res.ok ? res.text() : `Could not build the context (${res.status}).`;
  },
  history: async (): Promise<HistoryRun[]> => {
    const res = await fetch("/api/history");
    if (!res.ok) throw new Error(`could not load the history (${res.status})`);
    return res.json();
  },
  /** One PR in full. The server caches it for a minute; `refresh` skips the cache. */
  prDetail: async (ref: string, refresh = false): Promise<PrDetail> => {
    const res = await fetch(`/api/pr?ref=${encodeURIComponent(ref)}${refresh ? "&refresh" : ""}`, { headers: { "X-Agent-Dash": "1" } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `could not load the PR (${res.status})`);
    return json;
  },
  /** Saved in agent-dash only; resolves to the PR's addressed keys. */
  markAddressed: async (ref: string, key: string, addressed: boolean): Promise<string[]> => {
    const res = await fetch(`/api/pr/addressed?ref=${encodeURIComponent(ref)}`, { method: "POST", headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: JSON.stringify({ key, addressed }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `could not save (${res.status})`);
    return json.addressed;
  },
  document: async (id: number): Promise<TicketDocumentWithBody> => {
    const res = await fetch(`/api/document?id=${id}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `could not load the document (${res.status})`);
    return json;
  },
  /** An agent changes the document in place, as the prompt asks. */
  editDocument: (id: number, prompt: string, cwd: string) => post(`/api/document/edit?id=${id}`, { prompt, cwd }),
  /** Its diagram stays deleted, so the agent's log does not bring it back. */
  deleteDocument: (id: number) => post(`/api/document?id=${id}`, undefined, "DELETE"),
  /** Ends an edit that will not save. A ticket summary with no first version goes. */
  cancelDocumentEdit: (id: number) => post(`/api/document/edit?id=${id}`, undefined, "DELETE"),
  writeTicketSummary: (ticket: string, cwd: string) => post(`/api/document/ticket-summary?ticket=${encodeURIComponent(ticket)}`, { cwd }),
  transcript: async (sessionId: string): Promise<Transcript> => {
    const res = await fetch(`/api/transcript?session=${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(`could not load the chat (${res.status})`);
    return res.json();
  },
  setThread: (ticket: string, sessionId: string, status: ThreadStatus) =>
    post(`/api/threads?ticket=${encodeURIComponent(ticket)}&session=${encodeURIComponent(sessionId)}`, { status }),
};

// ---- markdown -----------------------------------------------------------------------

// Group 5 is a local image, `![alt](path)`, and group 6 a document's stored image; a web image stays a link.
// Group 7 is *italic* or _italic_; a snake_case name is not. Group 8 is an Obsidian `[[link]]` or `![[embed]]`.
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s)<>\]]+)|(!\[[^\]\n]*\]\((?![a-z]+:)<?[^)\s>]+\.(?:png|svg|jpe?g|gif|webp)>?\))|(!\[[^\]\n]*\]\(image:\d+\))|(\*(?![\s*])[^*\n]+?(?<!\s)\*|(?<!\w)_(?![\s_])[^_\n]+?(?<!\s)_(?!\w))|(!?\[\[[^\]\n]+\]\])/gi;

function linkLabel(url: string): string {
  if (/github\.com\/.+\/pull\/\d+/.test(url)) return prName(url);
  const jira = url.match(JIRA_BROWSE);
  return jira ? jira[1] : url.replace(/^https?:\/\//, "");
}

/** A PR or a known ticket opens in agent-dash on a click, but its href and a copy carry the GitHub or Jira URL. */
function Link({ url, label }: { url: string; label: ReactNode }) {
  const internal = internalHref(url, knownTickets);
  if (!internal) {
    return (
      <a href={url} target="_blank" rel="noreferrer" title={url}>
        {label}
      </a>
    );
  }
  const open = (e: MouseEvent) => {
    const where = dashClick(e);
    if (!where) return;
    e.preventDefault();
    if (where === "here") location.hash = internal;
    else window.open(internal, "_blank", "noopener");
  };
  return (
    <>
      <a href={url} onClick={open} onAuxClick={open} title={`Open in agent-dash · ${url}`}>
        {label}
      </a>
      <a className="ext-link" href={url} target="_blank" rel="noreferrer" title={`Open ${url}`} aria-label={`Open ${url}`}>
        ↗
      </a>
    </>
  );
}

// ---- wiki links ----------------------------------------------------------------------

/** Every name a `[[link]]` can use for a wiki note, lower case. Null until the Wiki view loads the list. */
let wikiNames: Set<string> | null = null;
export function setWikiNames(names: Set<string>): void {
  wikiNames = names;
}

/** `[[Note]]` opens the note in the Wiki view; `![[x.png]]` shows the image from the wiki; a broken link says so. */
function WikiLink({ token }: { token: string }) {
  const { embed, target, heading, label } = wikiLinkParts(token);
  if (embed && IMAGE_EXT.test(target)) {
    const src = `/api/wiki/file?ref=${encodeURIComponent(target)}`;
    return (
      <a className="md-image" href={src} target="_blank" rel="noreferrer" title={target}>
        <img src={src} alt={label ?? target} loading="lazy" />
      </a>
    );
  }
  const missing = wikiNames !== null && !wikiNames.has(target.toLowerCase().replace(/\.md$/i, ""));
  const text = label ?? (heading ? `${target} › ${heading}` : target);
  return (
    <a className={`wikilink ${missing ? "missing" : ""}`} href={href(`wiki:${target}`)} title={missing ? `No wiki note is named “${target}”` : `Open “${target}” in the wiki`}>
      {embed ? `↪ ${text}` : text}
    </a>
  );
}

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [tok] = m;
    if (m[1]) out.push(<code key={m.index}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={m.index}>{inline(tok.slice(2, -2))}</strong>);
    else if (m[7]) out.push(<em key={m.index}>{inline(tok.slice(1, -1))}</em>);
    else if (m[8]) out.push(<WikiLink key={m.index} token={tok} />);
    else if (m[5]) {
      const [, alt, path] = tok.match(/^!\[([^\]]*)\]\(<?([^)\s>]+)>?\)$/)!;
      out.push(<EmbeddedImage key={m.index} alt={alt} path={path} />);
    }
    else if (m[6]) {
      const [, alt, id] = tok.match(/^!\[([^\]]*)\]\(image:(\d+)\)$/)!;
      out.push(
        <a key={m.index} className="md-image" href={`/api/document/image?id=${id}`} target="_blank" rel="noreferrer" title={alt || "Open the image"}>
          <img src={`/api/document/image?id=${id}`} alt={alt} loading="lazy" />
        </a>,
      );
    }
    else if (m[3]) {
      const [, label, url] = tok.match(/^\[([^\]]+)\]\((.+)\)$/)!;
      out.push(<Link key={m.index} url={url} label={label} />);
    } else {
      const { url } = splitTrailing(tok);
      out.push(<Link key={m.index} url={url} label={linkLabel(url)} />);
      last = m.index + url.length;
      continue;
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Enough markdown for agent replies and documents: paragraphs, lists, headings, quotes, rules,
 * fences, tables, images, and inline code, bold, italic and links. React escapes all text, so a reply cannot inject HTML.
 */
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (line.startsWith("```")) {
      const lang = line.slice(3).trim().toLowerCase();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      blocks.push(lang === "mermaid" ? <MermaidFence key={i} code={body.join("\n")} /> : <pre key={i}>{body.join("\n")}</pre>);
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
      // One element for every level, so a reply's heading stays small; a document's CSS sizes it by level.
      blocks.push(<h4 key={i} data-level={line.match(/^#+/)![0].length}>{inline(line.replace(/^#+\s*/, ""))}</h4>);
      i++;
    } else if (HR.test(line)) {
      blocks.push(<hr key={i} />);
      i++;
    } else if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={i}><Markdown text={quote.join("\n")} /></blockquote>);
    } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={i}>{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</List>);
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*\||\s*>|\s*([-*•]|\d+[.)])\s+)/.test(lines[i]) && !HR.test(lines[i]); i++) para.push(lines[i]);
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
