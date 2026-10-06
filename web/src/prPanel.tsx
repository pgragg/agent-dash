import { useEffect, useRef, useState } from "react";
import { type FeedbackNote, mergeVerbs, type PrVerb, REVIEW_AND_MERGE, verbFor } from "../../shared/prVerbs.ts";
import { prRef } from "../../shared/refs.ts";
import type { AttentionItem, AttentionKind, Dashboard, PrCheck, PrDetail, PullRequest } from "../../shared/types.ts";
import { age, api, Markdown, plural, prName, runTitle } from "./lib.tsx";
import { type FeedbackEntry, type FeedbackState, feedback, feedbackCounts, openerRun, panelTarget, verbStart } from "./prView.ts";
import { href } from "./routes.ts";

/**
 * The PR panel (`#/pr:owner/repo/N`): what GitHub would show about one PR, read-only, plus one
 * verb button per signal. A verb starts an agent through the same endpoints as the board.
 */

const TONE: Partial<Record<AttentionKind, string>> = {
  changes_requested: "bad",
  ci_failing: "bad",
  merge_conflict: "bad",
  ready_to_merge: "good",
  in_review: "working",
};

const Dot = ({ tone }: { tone: string }) => <span className={`dot tone-${tone}`} aria-hidden />;

type StartState = { s: "idle" } | { s: "confirm" } | { s: "starting" } | { s: "started"; conversation: string | null } | { s: "error"; error: string };

/**
 * One verb for one PR signal. Null when the signal has no verb. The click is the approval. A PR
 * that is ready to merge gets a link to its panel instead: an approval can carry a request for a
 * change, so the merge is only on the panel, under the feedback.
 */
export function PrVerbButton({ item, data }: { item: AttentionItem; data: Dashboard }) {
  const pr = item.prUrl ? data.prs.find((p) => p.url === item.prUrl) : undefined;
  const verb = pr ? verbFor(item, pr) : null;
  if (!pr || !verb) return null;
  const ref = prRef(pr.url);
  if (verb.id === "merge" && ref) {
    return (
      <a className="btn small verb" href={href(ref)} title="Read the feedback on the PR panel, then merge there">
        {REVIEW_AND_MERGE}
      </a>
    );
  }
  return <VerbButton verb={verb} pr={pr} data={data} ticketKey={item.ticketKey} />;
}

function VerbButton({ verb, pr, data, ticketKey, quiet = false }: { verb: PrVerb; pr: PullRequest; data: Dashboard; ticketKey: string | null; quiet?: boolean }) {
  const [state, setState] = useState<StartState>({ s: "idle" });
  const { ticket, cwd } = verbStart(data, pr, ticketKey);
  const start = async () => {
    setState({ s: "starting" });
    if (ticket) {
      const error = await api.startAgent(ticket, verb.message, cwd);
      setState(error ? { s: "error", error } : { s: "started", conversation: null });
      return;
    }
    try {
      setState({ s: "started", conversation: await api.newConversation(verb.message, cwd) });
    } catch (err) {
      setState({ s: "error", error: (err as Error).message });
    }
  };
  const where = `${ticket ? `on ${ticket}` : "with no ticket"}, in ${cwd}`;
  if (state.s === "confirm") {
    return (
      <span className="verb-confirm">
        <span>{verb.confirm}</span>
        <button className="btn small primary" onClick={start}>
          Yes, {verb.label.toLowerCase()}
        </button>
        <button className="btn ghost small" onClick={() => setState({ s: "idle" })}>
          Cancel
        </button>
      </span>
    );
  }
  if (state.s === "started") {
    return state.conversation ? (
      <a className="btn ghost small verb" href={`#/c:${encodeURIComponent(state.conversation)}`}>
        Started ✓ · open
      </a>
    ) : (
      <span className="meta verb-done">Started ✓</span>
    );
  }
  return (
    <span className="verb-wrap">
      <button className={`btn small verb ${quiet ? "ghost" : ""}`} disabled={state.s === "starting"} title={`Start an agent ${where}:\n\n${verb.message}`} onClick={() => (verb.confirm ? setState({ s: "confirm" }) : start())}>
        {state.s === "starting" ? "Starting…" : verb.label}
      </button>
      {state.s === "error" && <span className="tone-text-bad verb-error">{state.error}</span>}
    </span>
  );
}

/** Starts scrolled to the end, where the error line is. */
function LogTail({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <pre ref={ref} className="pr-log">
      {text}
    </pre>
  );
}

const CHECK_ORDER = ["failure", "pending", "success", "neutral", "skipped"];
const checkTone = (state: string) => (state === "failure" ? "bad" : state === "pending" ? "warn" : state === "success" ? "good" : "muted");

function Checks({ checks }: { checks: PrCheck[] }) {
  const [showAll, setShowAll] = useState(false);
  const rank = (c: PrCheck) => (CHECK_ORDER.includes(c.state) ? CHECK_ORDER.indexOf(c.state) : CHECK_ORDER.length);
  const sorted = [...checks].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  // Passed and skipped checks are many and rarely matter; failures and pending ones always show.
  const quiet = sorted.filter((c) => c.state !== "failure" && c.state !== "pending");
  const shown = showAll || quiet.length <= 6 ? sorted : sorted.filter((c) => !quiet.includes(c));
  if (!checks.length) return <p className="meta">No checks ran on the last commit.</p>;
  return (
    <ul className="pr-checks">
      {shown.map((c, i) => (
        <li key={`${c.name}-${i}`}>
          <div className="pr-check-row">
            <Dot tone={checkTone(c.state)} />
            <span className="pr-check-name">{c.name}</span>
            <span className={`tag tone-${checkTone(c.state)}`}>{c.state}</span>
            <span className="grow" />
            {c.url && (
              <a className="ext-link" href={c.url} target="_blank" rel="noreferrer" title="Open the check's page" aria-label="Open the check's page">
                ↗
              </a>
            )}
          </div>
          {c.logTail && <LogTail text={c.logTail} />}
        </li>
      ))}
      {shown.length < sorted.length && (
        <li>
          <button className="btn ghost small" onClick={() => setShowAll(true)}>
            Show {plural(sorted.length - shown.length, "passed or skipped check")}
          </button>
        </li>
      )}
    </ul>
  );
}

const REVIEW: Record<string, [string, string]> = {
  APPROVED: ["approved", "good"],
  CHANGES_REQUESTED: ["changes requested", "bad"],
  REVIEW_REQUIRED: ["needs review", "muted"],
};

/**
 * GitHub renders HTML in bodies and comments, and templates and bots use a lot of it. The
 * markdown renderer shows HTML as text, so the common tags go and their text stays.
 */
const stripHtml = (body: string) =>
  body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(a|b|i|em|strong|p|div|span|sub|sup|details|summary|picture|source|img|h[1-6])\b[^>]*>/gi, "")
    .replace(/&(ensp|emsp|nbsp);/g, " ")
    .trim();

const FEEDBACK_TAG: Record<FeedbackState, [string, string]> = {
  to_address: ["to address", "warn"],
  replied: ["replied", "muted"],
  outdated: ["outdated", "muted"],
  addressed: ["marked addressed", "muted"],
};

/** The first line with words in it, for a bot's closed summary. */
const firstLine = (body: string) => stripHtml(body).split("\n").map((l) => l.replace(/^[#>*\s-]+/, "").trim()).find(Boolean) ?? "";

function FeedbackItem({ e, now, onMark }: { e: FeedbackEntry; now: number; onMark: (key: string, addressed: boolean) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mark = async (addressed: boolean) => {
    setBusy(true);
    setError(await onMark(e.key, addressed));
    setBusy(false);
  };
  const [word, tone] = FEEDBACK_TAG[e.state];
  const body = e.body ? stripHtml(e.body) : "";
  return (
    <li className={e.state === "to_address" ? "" : "fb-muted"}>
      <div className="pr-thread-head fb-head">
        <Dot tone={tone} />
        <span className={`tag tone-${tone}`}>{word}</span>
        <b>{e.author}</b>
        {e.bot && <span className="tag tone-muted">bot</span>}
        {e.kind === "review" && <span className="meta">{e.reviewState!.toLowerCase().replace(/_/g, " ")}</span>}
        {e.kind === "comment" && <span className="meta">commented</span>}
        {e.thread && (
          <span className="mono">
            {e.thread.path}
            {e.thread.line != null && `:${e.thread.line}`}
          </span>
        )}
        <span className="meta">{age(e.at, now)} ago</span>
        {e.state === "to_address" && e.commitSince && <span className="meta" title="A commit can fix it with no reply. Read the diff, then mark it addressed.">· a commit came after it</span>}
        <span className="grow" />
        {e.state === "to_address" && (
          <button className="btn ghost small" disabled={busy} onClick={() => mark(true)} title="Saved in agent-dash only. Nothing goes to GitHub.">
            Mark addressed
          </button>
        )}
        {e.state === "addressed" && (
          <button className="btn ghost small" disabled={busy} onClick={() => mark(false)}>
            Undo
          </button>
        )}
        <a className="ext-link" href={e.thread ? e.thread.comments[0].url : e.key} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label="Open on GitHub">
          ↗
        </a>
      </div>
      {error && <div className="tone-text-bad">{error}</div>}
      {body &&
        (e.bot ? (
          <details className="pr-comment">
            <summary>{firstLine(body)}</summary>
            <Markdown text={body} />
          </details>
        ) : (
          <div className="pr-comment">
            <Markdown text={body} />
          </div>
        ))}
      {e.thread?.comments.map((c, j) => (
        <div key={j} className="pr-comment">
          <div className="turn-head">
            <b>{c.author}</b>
            <span className="meta">{age(c.createdAt, now)} ago</span>
            {c.url && (
              <a className="ext-link" href={c.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label="Open on GitHub">
                ↗
              </a>
            )}
          </div>
          <Markdown text={stripHtml(c.body)} />
        </div>
      ))}
    </li>
  );
}

/** What the Address feedback agent reads about an entry. */
function note(e: FeedbackEntry): FeedbackNote {
  const last = e.thread?.comments.at(-1);
  return { author: e.author, url: e.key, text: e.thread ? `${e.thread.path}: ${last?.body ?? ""}` : (e.body ?? "") };
}

/** The merge, at the end of the feedback, so it is read first. With feedback to address, that comes first. */
function MergeVerbs({ pr, entries, data }: { pr: PullRequest; entries: FeedbackEntry[]; data: Dashboard }) {
  const open = entries.filter((e) => e.state === "to_address").map(note);
  const item = data.attention.find((a) => a.prUrl === pr.url && a.kind === "ready_to_merge");
  return (
    <div className="pr-merge">
      {mergeVerbs(pr, open).map((v, i) => (
        <VerbButton key={v.label} verb={v} pr={pr} data={data} ticketKey={item?.ticketKey ?? null} quiet={i > 0} />
      ))}
    </div>
  );
}

/** Review bodies, conversation comments, and unresolved threads, with what still needs an answer. */
function Feedback({ detail, review, now, onMark, merge }: { detail: PrDetail; review?: [string, string]; now: number; onMark: (key: string, addressed: boolean) => Promise<string | null>; merge?: { pr: PullRequest; data: Dashboard } }) {
  const entries = feedback(detail);
  return (
    <section className="card">
      <header className="card-head">
        <h3>Feedback</h3>
        {review && <span className={`tag tone-${review[1]}`}>{review[0]}</span>}
        {entries.length > 0 && <span className="meta">{feedbackCounts(entries)}</span>}
        <span className="grow" />
        <span className="meta">
          {detail.reviewers.map((r) => `${r.login}: ${r.state.toLowerCase().replace(/_/g, " ")}`).join(" · ")}
          {detail.requestedReviewers.length > 0 && ` · waiting on ${detail.requestedReviewers.join(", ")}`}
        </span>
      </header>
      {entries.length === 0 ? (
        <p className="meta">No review text, comments, or unresolved threads.</p>
      ) : (
        <ol className="pr-threads">
          {entries.map((e) => (
            <FeedbackItem key={e.key} e={e} now={now} onMark={onMark} />
          ))}
        </ol>
      )}
      {merge && <MergeVerbs pr={merge.pr} entries={entries} data={merge.data} />}
    </section>
  );
}

export function PrPanel({ refId, data, now }: { refId: string; data: Dashboard; now: number }) {
  const target = panelTarget(refId);
  if (!target) {
    return (
      <article className="workspace">
        <div className="toast">
          <code>{refId}</code> is not a PR address. A PR address looks like <code>#/pr:owner/repo/123</code>. <a href="#/prs">Open pull requests</a>
        </div>
      </article>
    );
  }
  return <Panel refId={refId} path={target.path} url={target.url} data={data} now={now} />;
}

function Panel({ refId, path, url, data, now }: { refId: string; path: string; url: string; data: Dashboard; now: number }) {
  const pr = data.prs.find((p) => prRef(p.url)?.toLowerCase() === refId.toLowerCase());
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A slow refresh must not overwrite a newer answer that came back first.
  const sent = useRef(0);
  const load = async (refresh: boolean) => {
    const seq = ++sent.current;
    setLoading(true);
    try {
      const d = await api.prDetail(path, refresh);
      if (seq !== sent.current) return;
      setDetail(d);
      setError(null);
    } catch (err) {
      if (seq === sent.current) setError((err as Error).message);
    } finally {
      if (seq === sent.current) setLoading(false);
    }
  };
  // Again when the dashboard sees the PR change; the server cache keeps this cheap.
  useEffect(() => {
    load(false);
  }, [path, pr?.updatedAt]);

  const items = data.attention.filter((a) => a.prUrl === (pr?.url ?? url));
  const tickets = [...new Set([...(pr?.tickets ?? []), ...(detail?.tickets ?? [])])];
  const known = new Map([...data.myTickets, ...data.otherTickets].map((g) => [g.ticket.key, g.ticket]));
  const opener = openerRun(data, pr?.url ?? url);
  const state = detail?.state ?? pr?.state;
  const draft = (detail?.isDraft ?? pr?.isDraft) && state === "open";
  const review = REVIEW[detail?.reviewDecision ?? pr?.reviewDecision ?? ""];
  const title = detail?.title ?? pr?.title ?? prName(url);
  const body = detail ? stripHtml(detail.body) : "";
  const mark = async (key: string, addressed: boolean) => {
    try {
      const keys = await api.markAddressed(path, key, addressed);
      setDetail((d) => (d ? { ...d, addressed: keys } : d));
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  return (
    <article className="workspace pr-panel" id={refId}>
      <header className="ws-head">
        <div className="eyebrow">
          <a href="#/prs">← Open pull requests</a>
        </div>
        <h1>{title}</h1>
        <div className="ws-meta">
          {state && <span className={`pr-state state-${draft ? "draft" : state}`}>{draft ? "draft" : state}</span>}
          <a className="key-link" href={url} target="_blank" rel="noreferrer" title="Open on GitHub">
            {prName(url)} ↗
          </a>
          {detail?.author && <span className="meta">by {detail.author}</span>}
          {detail && (
            <span className="meta mono">
              {detail.headRef} → {detail.baseRef}
            </span>
          )}
          {review && <span className={`tag tone-${review[1]}`}>{review[0]}</span>}
          {(detail?.mergeable ?? pr?.mergeable) === "CONFLICTING" && <span className="tag tone-bad">conflict</span>}
          <span className="grow" />
          {detail && <span className="meta">fetched {age(detail.fetchedAt, now)} ago</span>}
          <button className="btn ghost small" onClick={() => load(true)} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {items.length > 0 && (
          <ul className="why">
            {items.map((a) => (
              <li key={a.kind}>
                <Dot tone={TONE[a.kind] ?? "muted"} />
                <span>{a.reason}</span>
                {/* The merge is at the end of the Feedback section. */}
                {a.kind !== "ready_to_merge" && <PrVerbButton item={a} data={data} />}
              </li>
            ))}
          </ul>
        )}
      </header>

      {error && <div className="toast">{error}</div>}
      {!pr && <p className="meta">This PR is not one of your open PRs from the last 14 days, so it has no signals or verbs here.</p>}

      {detail ? <Feedback detail={detail} review={review} now={now} onMark={mark} merge={pr && items.some((a) => a.kind === "ready_to_merge") ? { pr, data } : undefined} /> : !error && <span className="shimmer wide" />}

      <section className="card">
        <header className="card-head">
          <h3>Tickets and runs</h3>
        </header>
        <div className="pr-links">
          {tickets.length === 0 && <span className="meta">No ticket key in the title or branch.</span>}
          {tickets.map((k) =>
            known.has(k) ? (
              <div key={k}>
                <a className="key-link" href={href(`t:${k}`)} title="Open the ticket on the board">
                  {k}
                </a>
                <span>{known.get(k)!.summary}</span>
              </div>
            ) : (
              <div key={k}>
                <span className="key-link">{k}</span>
                <span className="meta">not on the board</span>
              </div>
            ),
          )}
        </div>
        {opener && (
          <p className="pr-opener">
            <span className="meta">Opened by</span> <a href={opener.headless ? `#/c:${encodeURIComponent(opener.sessionId)}` : href(`r:${opener.sessionId}`)}>{runTitle(opener)}</a>{" "}
            <span className="meta">· {age(opener.lastActivityAt, now)} ago</span>
          </p>
        )}
      </section>

      {detail && (
        <>
          <section className="card">
            <header className="card-head">
              <h3>Checks</h3>
              <span className="grow" />
              <span className="meta">{plural(detail.checkRuns.length, "check")} on the last commit</span>
            </header>
            <Checks checks={detail.checkRuns} />
          </section>

          <section className="card">
            <header className="card-head">
              <h3>Description</h3>
            </header>
            {body ? <Markdown text={body} /> : <p className="meta">No description.</p>}
          </section>

          <section className="card">
            <header className="card-head">
              <h3>Files</h3>
              <span className="grow" />
              <span className="meta">
                <span className="tone-text-good">+{detail.additions}</span> <span className="tone-text-bad">−{detail.deletions}</span> in {plural(detail.changedFiles, "file")}
              </span>
            </header>
            <ul className="pr-files">
              {detail.files.map((f) => (
                <li key={f.path}>
                  <span className="mono pr-file">{f.path}</span>
                  <span className="tone-text-good">+{f.additions}</span>
                  <span className="tone-text-bad">−{f.deletions}</span>
                </li>
              ))}
              {detail.changedFiles > detail.files.length && <li className="meta">and {plural(detail.changedFiles - detail.files.length, "more file")}</li>}
            </ul>
          </section>
        </>
      )}
    </article>
  );
}
