/**
 * An exit is one time the developer leaves agent-dash for another tool. Counting them shows
 * which link to replace with an in-dash view next. Pure, so the tests import it without a DOM.
 */

export const EXIT_KINDS = ["github_pr", "jira", "slack", "iterm_focus", "copy_resume", "other_url"] as const;
export type ExitKind = (typeof EXIT_KINDS)[number];

export const EXIT_VIEWS = ["board", "needs", "prs", "history", "conversation", "diagrams", "diagram", "worktrees", "parked", "settings"] as const;
export type ExitView = (typeof EXIT_VIEWS)[number];

export interface Exit {
  kind: ExitKind;
  host: string | null;
  view: ExitView | null;
  section: string | null;
  ticket: string | null;
}

export interface ExitCount {
  kind: ExitKind;
  section: string;
  count: number;
}

const JIRA_KEY = /^\/browse\/([A-Z][A-Z0-9]+-\d+)/;

/** What kind of exit a link is, from its href alone. */
export function classifyHref(href: string): { kind: ExitKind; host: string | null; ticket: string | null } {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: "other_url", host: null, ticket: null };
  }
  const host = url.hostname.toLowerCase();
  const ticket = url.pathname.match(JIRA_KEY)?.[1] ?? null;
  const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (is("github.com") && /^\/[^/]+\/[^/]+\/pull\/\d+/.test(url.pathname)) return { kind: "github_pr", host, ticket: null };
  if (is("atlassian.net") || ticket) return { kind: "jira", host, ticket };
  if (is("slack.com")) return { kind: "slack", host, ticket: null };
  return { kind: "other_url", host, ticket: null };
}

/** Nearest first: the first ancestor whose classes match names the section. */
const SECTIONS: [string, string][] = [
  ["pr-row", "pr row"],
  ["pr-line", "pr row"],
  ["pr-checks", "pr panel checks"],
  ["pr-threads", "pr panel review"],
  ["pr-panel", "pr panel"],
  ["ticket-comments", "ticket comments"],
  ["ticket-panel", "ticket section"],
  ["slack-quotes", "slack quotes"],
  ["pr-group-head", "pr group header"],
  ["agent-message", "agent message"],
  ["h-message", "history message"],
  ["turn", "chat turn"],
  ["h-row", "history row"],
  ["action", "action row"],
  ["ws-meta", "workspace header"],
  ["ws-head", "workspace header"],
  ["next-steps", "next steps"],
  ["notes", "notes"],
  ["start-agent", "start agent"],
  ["agent", "agent card"],
  ["q-item", "queue"],
  ["rail", "queue"],
  ["topbar", "top bar"],
];

/** The section label for a chain of ancestor class names, nearest first. */
export function sectionOf(classChain: string[]): string {
  for (const cls of classChain) {
    const names = cls.split(/\s+/);
    const hit = SECTIONS.find(([c]) => names.includes(c));
    if (hit) return hit[1];
  }
  return "page";
}

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const KEY_IN_HREF = /(?:\/browse\/|^#\/t:)([A-Z][A-Z0-9]+-\d+)/;
const keyIn = (hrefs: string[]) => hrefs.map((h) => h.match(KEY_IN_HREF)?.[1]).find(Boolean) ?? null;

/**
 * The ticket of the page area clicked: the selected ticket (`#/t:KEY`), else the key link of the
 * nearest box (PR group, action row), else of the workspace, else the key in the link itself.
 * A box without a key link means "no ticket", so it never borrows a neighbour's key.
 */
export function pickTicket(hash: string, boxHrefs: string[] | null, workspaceHrefs: string[], fromHref: string | null): string | null {
  let ref = "";
  try {
    ref = decodeURIComponent(hash.match(/^#\/t:([^/]+)$/)?.[1] ?? "");
  } catch {}
  if (KEY.test(ref)) return ref;
  return (boxHrefs ? keyIn(boxHrefs) : keyIn(workspaceHrefs)) ?? fromHref;
}

const cap = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

/**
 * Validates an exit posted by the page. Null when the kind is unknown, so the table holds only
 * known kinds. `ticketPattern` is the configured key pattern; other keys are dropped, not refused.
 */
export function parseExit(body: unknown, ticketPattern: RegExp): Exit | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!EXIT_KINDS.includes(b.kind as ExitKind)) return null;
  const ticket = cap(b.ticket, 32);
  const view = EXIT_VIEWS.includes(b.view as ExitView) ? (b.view as ExitView) : null;
  return {
    kind: b.kind as ExitKind,
    host: cap(b.host, 100)?.toLowerCase() ?? null,
    view,
    section: cap(b.section, 40),
    ticket: ticket && new RegExp(`^${ticketPattern.source}$`).test(ticket) ? ticket : null,
  };
}
