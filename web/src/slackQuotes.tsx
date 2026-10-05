import { useEffect, useState } from "react";
import type { SlackQuote } from "../../shared/types.ts";

/**
 * The Slack messages that a next-steps summary links to, quoted from the summary run's own
 * Slack search, so you can read them without going to Slack.
 */
export function SlackQuotes({ summaryId, text }: { summaryId: number; text: string }) {
  const [quotes, setQuotes] = useState<SlackQuote[]>([]);
  const cites = /\.slack\.com\/archives\//.test(text);
  useEffect(() => {
    if (!cites) return;
    let current = true;
    fetch(`/api/summaries/slack?id=${summaryId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((q: SlackQuote[]) => current && setQuotes(q))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [summaryId, cites]);
  if (!quotes.length) return null;
  return (
    <details className="slack-quotes">
      <summary>
        Slack · {quotes.length === 1 ? "the message" : `the ${quotes.length} messages`} this draft links to
      </summary>
      {quotes.map((q) => (
        <blockquote key={q.permalink}>
          <div className="note-meta">
            <span>{q.channel === "DM" ? "DM" : `#${q.channel}`}</span>
            <span>· @{q.user}</span>
            <span>· {new Date(Number(q.ts) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            <a href={q.permalink} target="_blank" rel="noreferrer" title="Open in Slack">
              ↗
            </a>
          </div>
          <p>{q.text}</p>
        </blockquote>
      ))}
    </details>
  );
}
