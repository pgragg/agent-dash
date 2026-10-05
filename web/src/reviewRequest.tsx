import { useEffect, useState } from "react";
import { fallbackMessage, REVIEW_CHANNEL, wantsReviewRequest } from "../../shared/reviewRequest.ts";
import type { PullRequest, ReviewDraft, SdlcEvent } from "../../shared/types.ts";
import { age, post } from "./lib.tsx";

/**
 * The drafted Slack review request under a PR on the PRs view. Post sends it to the review
 * channel as Piper; the click is the approval. The server records it as a review_request event.
 */

/** Asks the server to draft every open PR that has no draft yet. It runs the drafts in the background. */
export function useReviewDrafts(prs: PullRequest[], drafts: Record<string, ReviewDraft>): void {
  // Only the PRs with no draft row: a finished draft changes the key once, and then it is stable.
  const missing = prs
    .filter((p) => wantsReviewRequest(p) && !drafts[p.url])
    .map((p) => p.url)
    .sort()
    .join(" ");
  useEffect(() => {
    // Also on each page load: the server retries a failed or stuck draft after a few minutes.
    void post("/api/review-drafts");
  }, [missing]);
}

export function ReviewRequest({ pr, draft, sent, now }: { pr: PullRequest; draft: ReviewDraft | undefined; sent: SdlcEvent[] | undefined; now: number }) {
  /** Null until Piper edits the text. */
  const [edited, setEdited] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [again, setAgain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = sent?.[0];
  // A new draft replaces an edit that started from the old one.
  useEffect(() => setEdited(null), [draft?.text]);

  if (last && !again) {
    return (
      <div className="review-req sent">
        <span className="tone-text-good">✓</span>
        <span>
          Review requested in #{REVIEW_CHANNEL.name} <span className="meta">· {age(last.startedAt, now)} ago</span>
        </span>
        {last.messageUrl && (
          <a href={last.messageUrl} target="_blank" rel="noreferrer">
            Open in Slack ↗
          </a>
        )}
        <span className="grow" />
        <button className="btn ghost small" onClick={() => setAgain(true)}>
          Post again
        </button>
      </div>
    );
  }

  const drafting = !draft || draft.status === "in_progress";
  const text = edited ?? (draft?.status === "done" && draft.text ? draft.text : draft?.status === "failed" ? fallbackMessage(pr.title, pr.url) : "");
  const send = async () => {
    if (posting || !text.trim()) return;
    setPosting(true);
    const err = await post("/api/review-requests", { prUrl: pr.url, text });
    setPosting(false);
    setError(err);
    if (!err) setAgain(false);
  };
  return (
    <div className="review-req">
      {drafting && edited === null ? (
        <span className="review-text drafting">Drafting a review request…</span>
      ) : (
        <input
          className="review-text"
          value={text}
          aria-label={`Slack review request for ${pr.repo}#${pr.number}`}
          title="Edit the message before you post it. ⌘↵ posts it."
          onChange={(e) => setEdited(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
        />
      )}
      <span className="meta">
        {draft?.status === "failed" && edited === null ? <span title={draft.error ?? ""}>The draft failed, so this is the PR title. </span> : null}
        Slack draft for #{REVIEW_CHANNEL.name}, posted as you
      </span>
      {error && <span className="tone-text-bad">{error}</span>}
      <span className="grow" />
      {again && (
        <button className="btn ghost small" onClick={() => setAgain(false)}>
          Cancel
        </button>
      )}
      {!drafting && (
        <button
          className="btn ghost small"
          title="Ask the model for a new draft"
          onClick={async () => {
            setEdited(null);
            setError(await post(`/api/review-drafts?pr=${encodeURIComponent(pr.url)}`));
          }}
        >
          Redraft
        </button>
      )}
      <button className="btn small" disabled={posting || !text.trim()} onClick={send} title={`Post this message to #${REVIEW_CHANNEL.name} as you, and record a review request on the ticket.`}>
        {posting ? "Posting…" : "Post to Slack"}
      </button>
    </div>
  );
}
