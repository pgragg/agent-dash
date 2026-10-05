import { useEffect } from "react";
import { needsNothing } from "../../shared/conversationSummary.ts";
import type { ConversationSummary, Run } from "../../shared/types.ts";
import { age, api } from "./lib.tsx";

/** What the agent needs from Piper. A working agent needs nothing until it stops, whatever the last draft said. */
function needsText(run: Run, s: ConversationSummary): string {
  if (run.dialog) return `Answer the dialog: ${run.dialog.title}`;
  if (run.status === "working") return "Nothing now: the agent is working.";
  return s.needs ?? "";
}

function note(s: ConversationSummary, now: number): string {
  if (s.status === "in_progress") return "updating…";
  if (s.stale) return "out of date";
  if (s.status === "failed") return "the last update failed";
  return `summarised ${age(s.generatedAt, now)} ago`;
}

/**
 * The short summary of an agent conversation: what it is about, what the agent said last, and
 * what it needs from Piper. With `onToggle`, a click on it shows or hides the details under it.
 */
export function ConversationGist({ run, summary, now, open, onToggle }: { run: Run; summary: ConversationSummary | undefined; now: number; open?: boolean; onToggle?: () => void }) {
  // The server drafts live runs by itself; a finished one is drafted when it shows.
  const wanted = run.status === "finished" && (!summary || (summary.stale && summary.status !== "in_progress"));
  useEffect(() => {
    if (wanted) void api.summarizeConversation(run.sessionId);
  }, [wanted, run.sessionId, run.lastActivityAt]);

  const toggle = onToggle && (
    <button className="btn ghost small gist-toggle" aria-expanded={open} onClick={onToggle}>
      {open ? "Hide the details" : "Show the details"}
    </button>
  );
  if (!summary?.about) {
    if (!summary && !wanted) return null;
    return (
      <div className="gist pending">
        {summary?.status === "failed" ? <span className="meta">Could not summarise the conversation: {summary.error}</span> : <span className="meta"><span className="shimmer" /> Summarising the conversation…</span>}
        {toggle}
      </div>
    );
  }
  const needs = needsText(run, summary);
  const nothing = needsNothing(needs) || run.status === "working";
  return (
    <div className={`gist ${onToggle ? "clickable" : ""}`} onClick={onToggle && ((e) => (e.target as HTMLElement).closest("button") || window.getSelection()?.toString() || onToggle())} title={onToggle ? (open ? "Hide the details" : "Show the last message and the conversation") : undefined}>
      <dl>
        <dt>About</dt>
        <dd>{summary.about}</dd>
        <dt>Latest</dt>
        <dd>{summary.latest}</dd>
        <dt>Needs from you</dt>
        <dd className={nothing ? "" : "needs"}>{needs}</dd>
      </dl>
      <div className="gist-foot">
        <span className="meta" title={summary.error ?? summary.generatedAt ?? undefined}>
          {note(summary, now)}
        </span>
        <span className="grow" />
        {toggle}
      </div>
    </div>
  );
}
