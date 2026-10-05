import type { Dashboard } from "../../shared/types.ts";

/**
 * Every object in agent-dash has an address in the URL hash. Kept free of React so the tests can import it.
 *
 * | Hash              | Object                                            |
 * |-------------------|---------------------------------------------------|
 * | `#/t:KEY`         | A ticket on the board                             |
 * | `#/r:SESSION`     | A run on the board, under its ticket if it has one |
 * | `#/step:ID`       | A drafted next step, on its ticket                |
 * | `#/note:ID`       | A note, on its ticket                             |
 * | `#/pr:OWNER/REPO/N` | The PR panel (a view under PRs)                 |
 * | `#/a:ID`          | An action on the Actions view                     |
 * | `#/needs`         | The list behind "N things need you"               |
 * | `#/c:SESSION`     | A conversation's page                             |
 *
 * On the page, the element of a run, step, note, PR, or action has its ref as its DOM id.
 */

export type Route =
  | { view: "board"; ref: string | null }
  | { view: "actions"; action: string | null }
  | { view: "needs" }
  | { view: "prs"; pr: string | null }
  | { view: "history" }
  | { view: "conversation"; id: string | null };

export function parseHash(hash: string): Route {
  const path = decodeURIComponent(hash.replace(/^#\/?/, ""));
  if (path === "actions") return { view: "actions", action: null };
  if (/^a:\d+$/.test(path)) return { view: "actions", action: path };
  if (path === "needs") return { view: "needs" };
  if (path === "prs") return { view: "prs", pr: null };
  if (path.startsWith("pr:")) return { view: "prs", pr: path };
  if (path === "history") return { view: "history" };
  if (path === "c" || path.startsWith("c:")) return { view: "conversation", id: path.slice(2) || null };
  return { view: "board", ref: path || null };
}

/** `#/t:FSDK-1`: the ref stays readable, and only what would break the hash is escaped. */
export function href(ref: string): string {
  return `#/${encodeURIComponent(ref).replace(/%3A/gi, ":").replace(/%2F/gi, "/")}`;
}

type BoardData = Pick<Dashboard, "myTickets" | "otherTickets" | "summaries" | "notes">;

/**
 * Which board entry a ref selects, and which element in it to show. A ref for a run on a
 * ticket, a step, or a note opens the ticket. Null when the object is not on the board.
 */
export function resolveBoardRef(ref: string, d: BoardData, subjects: Set<string>): { subjectId: string; anchor: string | null } | null {
  if (subjects.has(ref)) return { subjectId: ref, anchor: null };
  const groups = [...d.myTickets, ...d.otherTickets];
  const [kind, rest] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  if (kind === "r") {
    const has = groups.filter((g) => g.runs.some((r) => r.sessionId === rest));
    // A ticket where the thread still counts, before one where you resolved it.
    const g = has.find((g) => g.threads[rest]?.status !== "resolved") ?? has[0];
    return g ? { subjectId: `t:${g.ticket.key}`, anchor: ref } : null;
  }
  if (kind === "step") {
    const id = Number(rest);
    for (const [key, s] of Object.entries(d.summaries)) {
      if ([s.latest, s.lastDone].some((x) => x?.steps.some((st) => st.id === id))) return subjects.has(`t:${key}`) ? { subjectId: `t:${key}`, anchor: ref } : null;
    }
    return null;
  }
  if (kind === "note") {
    const id = Number(rest);
    for (const [key, notes] of Object.entries(d.notes)) {
      if (notes.some((n) => n.id === id)) return subjects.has(`t:${key}`) ? { subjectId: `t:${key}`, anchor: ref } : null;
    }
    return null;
  }
  return null;
}

const UNITS: [number, string][] = [
  [365 * 86_400, "year"],
  [30 * 86_400, "month"],
  [7 * 86_400, "week"],
  [86_400, "day"],
  [3600, "hour"],
  [60, "minute"],
];

/** "just now", "5 minutes", "3 hours", "2 days", "6 weeks". */
export function humanAge(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  for (const [size, unit] of UNITS) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  return "just now";
}
