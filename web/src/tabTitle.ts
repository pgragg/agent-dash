import type { Dashboard, PullRequest } from "../../shared/types.ts";
import { prRef } from "../../shared/refs.ts";
import type { Route } from "./routes.ts";

/**
 * The browser tab's title. Kept free of React so the tests can import it.
 *
 * A narrow Chrome tab shows only the first 10 to 20 characters, so the title starts with what
 * tells two agent-dash tabs apart: the view, then its counts, then the object that is open.
 * The app name goes last, because the favicon already says it.
 *
 *   Board (3) · Fix the login redirect · agent-dash
 *   PRs 5 · 2✓ 1💬 1✗ · agent-dash          5 open, 2 approved, 1 with feedback, 1 with red CI
 *   PR ✓ 💬2 · Fix the login redirect · agent-dash
 *   ✋ Deploy FDR · agent-dash               a chat that waits on you (⚙️ when it works)
 */

type TitleData = Pick<Dashboard, "prs" | "documents" | "parked" | "counts" | "myTickets" | "otherTickets" | "unlinkedRuns">;

export interface TitleInput {
  route: Route;
  data: TitleData | null;
  /** How many entries are in the queue. */
  queue: number;
  /** The title of the board entry that the workspace shows, or null when none is open. */
  open: string | null;
}

const APP = "agent-dash";
const MAX = 40;

const approved = (p: PullRequest) => p.reviewDecision === "APPROVED";
const hasFeedback = (p: PullRequest) => (p.toAddress ?? 0) > 0 || p.reviewDecision === "CHANGES_REQUESTED";
const ciRed = (p: PullRequest) => p.checks === "failure";

function short(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX ? `${one.slice(0, MAX - 1).trimEnd()}…` : one;
}

/** "2✓ 1💬 1✗", without the zero counts. */
function prCounts(prs: PullRequest[]): string {
  return [
    [prs.filter(approved).length, "✓"],
    [prs.filter(hasFeedback).length, "💬"],
    [prs.filter(ciRed).length, "✗"],
  ]
    .filter(([n]) => n)
    .map(([n, glyph]) => `${n}${glyph}`)
    .join(" ");
}

/** One PR's state: "✓ 💬2 ✗", or "merged" and "closed" when it is not open. */
function prState(p: PullRequest): string {
  if (p.state !== "open") return p.state;
  const feedback = p.toAddress ? `💬${p.toAddress}` : p.reviewDecision === "CHANGES_REQUESTED" ? "💬" : "";
  return [p.isDraft && "draft", approved(p) && "✓", feedback, ciRed(p) && "✗"].filter(Boolean).join(" ");
}

/** "View counts · object · agent-dash", without the empty parts. */
function join(view: string, counts: string | number | null, object?: string | null): string {
  const head = counts ? `${view} ${counts}` : view;
  return [head, object && short(object), APP].filter(Boolean).join(" · ");
}

export function tabTitle({ route, data, queue, open }: TitleInput): string {
  if (!data) return APP;
  const runs = () => [...data.myTickets, ...data.otherTickets].flatMap((g) => g.runs).concat(data.unlinkedRuns);
  switch (route.view) {
    case "board": {
      // Most entries in the queue are agents that wait on you, but an agent can wait without one.
      const n = queue || data.counts.awaiting_input;
      return join("Board", n ? `(${n})` : null, open);
    }
    case "needs":
      return join("Notifications", queue ? `(${queue})` : null);
    case "prs": {
      if (route.pr) {
        const ref = route.pr.toLowerCase();
        const p = data.prs.find((x) => prRef(x.url)?.toLowerCase() === ref);
        // A PR that is not on the board still has a readable "repo#n" in its address.
        const name = route.pr.replace(/^pr:/, "").replace(/\/(\d+)$/, "#$1");
        return join("PR", p ? prState(p) : null, p?.title ?? name);
      }
      const prs = data.prs.filter((p) => p.state === "open");
      const counts = prCounts(prs);
      return join("PRs", counts ? `${prs.length} · ${counts}` : prs.length || null);
    }
    case "history": {
      const live = data.counts.working + data.counts.awaiting_input;
      return join("History", live ? `${live} live` : null);
    }
    case "conversation": {
      if (!route.id) return join("New chat", null);
      const run = runs().find((r) => r.sessionId === route.id);
      if (!run) return join("Chat", null);
      // No view word: the tab is narrow, and the run's name says enough. ✋ waits on you, ⚙️ works.
      const state = run.status === "awaiting_input" ? "✋ " : run.status === "working" ? "⚙️ " : "";
      return join(`${state}${short(run.name ?? run.firstPrompt)}`, null);
    }
    case "documents":
      return join("Documents", data.documents.length || null);
    case "document":
    case "diagram": {
      const d = data.documents.find((x) => (route.view === "document" ? x.id === route.id : x.diagramId === route.id));
      return join("Doc", null, d?.title);
    }
    case "parked":
      return join("Parked", data.parked.length || null);
    case "worktrees":
      return join("Worktrees", null);
    case "settings":
      return join("Settings", null);
    case "localUrl":
      return join("Help", null, "Local URL");
    case "wiki":
      // A note's address is its path; the file name reads well enough as the object.
      return join("Wiki", null, route.ref ? route.ref.replace(/^.*\//, "").replace(/\.md$/i, "") : null);
  }
}
