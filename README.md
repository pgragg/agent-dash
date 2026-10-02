# agent-dash

A local dashboard for one person who oversees many coding agents at the same time.
It answers one question: **what do I look at next?**

It reads your pi session logs, your Jira tickets, and your GitHub PRs, and it shows:

1. **Focus next**: a ranked list of the things that wait for you. Each row says why it is there.
2. **My tickets**: your open Jira tickets. Under each ticket are its agent runs, oldest first, and its PRs.
3. **Other tickets with recent runs**, and **runs with no ticket**, folded away at the bottom.

The dashboard is read-only. It never writes to Jira, GitHub, or a pi session.

## Run it

```bash
pnpm install
pnpm install-extension   # once: exact run status (see below)
pnpm build && pnpm start # http://127.0.0.1:7777
```

`pnpm dev` runs the server with `--watch` and Vite on http://127.0.0.1:7778.

The server listens on `127.0.0.1` only, because the page shows prompts and replies from every session.

## Where the data comes from

| Source | How | Notes |
|---|---|---|
| pi sessions | `~/.pi/agent/sessions/**/*.jsonl` | Re-parses only the files that changed. A cold scan of about 700 sessions takes about 1 s. |
| Run status | `~/.agent-dash/status/<sessionId>.json`, written by `extension/agent-dash-status.ts` | Without it, status is a guess from the log, marked `?` |
| Jira | `POST /rest/api/3/search/jql` with the token in `~/pi/secrets/jira/.env.personal` | Open tickets assigned to you, excluding the deprecated `FSM` project |
| GitHub | `gh api graphql` with your `gh` login | Your PRs updated in the last 14 days, with CI, review, and merge state |

Jira and GitHub answers are cached for 2 minutes. After the first load, a stale answer is shown at once and refreshed in the background. **refresh** forces a new fetch.

The page updates live: the server watches the session and status folders and pushes a change event over SSE.

## How a run links to a ticket

A ticket key (`FSDK-123`, `EFSUP-45`, any case) is scored by where it appears in the session:

| Where | Weight |
|---|---|
| Session name | 5 |
| Your prompts | 3 |
| Tool-call arguments (branch names, `gh pr create --title`) | 1 |
| Assistant text | 1, at most once per session |
| Tool results | ignored: one `board` call prints every open ticket |

A run links to its strongest keys: at most 3, each with a score of at least 3 and at least a third of the top score.

PRs link to tickets by the key in their title or branch. Then two rules cross the gap:
- A run that opened a PR (`gh pr create` in the log) takes the PR's tickets.
- A PR with no key takes the main ticket of the run that opened it.

## Run status

| Status | With the extension | Without it (guess) |
|---|---|---|
| working | `agent_start` fired and the pi process is alive | The log ends mid-run and changed in the last 10 min |
| awaiting input | `agent_settled` fired and the pi process is alive | The log ends on a finished reply less than 4 h old |
| finished | `session_shutdown` fired, or the pid is gone | Everything else |

The extension writes its status file on `agent_settled`, not on `agent_end`, because pi can still retry or run queued messages after `agent_end`.

## Jump to a run's iTerm tab

A live run shows **open tab**. A finished run shows **copy resume**, which copies `cd <cwd> && pi --session <id>`.

- The extension records the iTerm2 session uuid from `ITERM_SESSION_ID`.
- `POST /api/focus?session=<id>` reads the uuid from the status file, never from the request. Then it runs an AppleScript that selects the window, tab and pane, and activates iTerm2.
- The endpoint needs an `X-Agent-Dash: 1` header. That forces a CORS preflight, which the server never answers, so another web page cannot call it.
- **macOS permission:** the app that started the server needs Automation access to iTerm2. If `dash` started it in iTerm, turn on **System Settings → Privacy & Security → Automation → iTerm → iTerm2**. Without it the button says so, and offers the resume command.
- Runs that started before the extension was installed have no tab id until you type `/reload` in them.

## Focus ranking

Higher scores come first. The rules are in `server/attention.ts`.

| Item | Score |
|---|---|
| Live run stopped on an API error | 110 |
| Live run waiting for you | 100, + up to 60 for the time waited, + 30 if it asked a question. ×0.6 if guessed. 35 after 24 h. |
| Your PR: a reviewer asked for changes | 95 |
| Run died on an API error in the last 24 h | 90 |
| Your PR: CI is red | 85 |
| Your PR: merge conflict | 80 |
| Your PR: approved and green, ready to merge | 70 |
| Ticket overdue | 60, + days late (up to 20), + priority |
| Ticket due within 2 days | 50, + priority |
| In-progress ticket with no run for 3 days and no open PR | 25, + priority |

Draft PRs score half. Tickets that are On Hold, Blocked, Waiting or Deferred score 25 less.

## Next-steps summaries

Each Focus row with a ticket has a **next steps** link. **summarize** starts a headless pi run that writes a very short summary for the ticket: its state, 1 to 4 next steps with who acts, and its blockers.

1. The server adds an `in_progress` row to SQLite (`~/.agent-dash/agent-dash.db`, table `summaries`) with the ticket and `requested_at`.
2. It writes `~/.agent-dash/summaries/<id>/context.md` with what it already knows: ticket fields, linked PRs, and a digest of each pi session about the ticket (prompts and replies, no tool output, newest first within a 60k-character budget).
3. It starts `pi -p --no-extensions --tools read,bash --session-dir ~/.agent-dash/summary-sessions`. The separate session folder keeps summary runs out of the ticket's run list. The prompt is read-only, and tells the run to read the context, then `jira issue view --comments`, `gh pr view --comments`, and `scripts/slack-search.ts`.
4. The run saves its summary with `node scripts/save-summary.ts <id> < summary.md`. That sets `status = done` and `generated_at`.

| State on the page | Meaning |
|---|---|
| summarize | No summary yet |
| summarizing 2m… | A run is in progress. The last finished summary stays readable meanwhile. |
| summary ▸ | Expands the summary, with when it was requested and generated, and a re-request link |
| stuck · re-request | In progress for more than 30 minutes. Re-request stops the old run and starts a new one. |
| failed · retry | The run ended without a summary. Hover for the error. |

If a run exits without saving, the server takes its last reply (pi -p prints it) as the summary. If there is no reply, it marks the row failed. The server also stops a run after 30 minutes. Runs are detached and write to log files, so a server restart does not stop them. On the next page load, the server checks rows whose pid is gone.

`scripts/slack-search.ts "<query>"` searches Slack read-only. It opens Slack once with the saved login in `~/pi/secrets/slack/` and calls Slack's `search.messages` from inside the page, because clicking through the search box from a headless browser is unreliable.

Optional: `AGENT_DASH_SUMMARY_MODEL` and `AGENT_DASH_SUMMARY_THINKING` choose the model and thinking level of summary runs.

## Configuration

Environment variables, all optional: `AGENT_DASH_PORT`, `AGENT_DASH_SESSIONS_DIR`, `AGENT_DASH_STATUS_DIR`, `AGENT_DASH_PROJECTS` (default `FSDK|EFSUP`), `AGENT_DASH_EXCLUDE_PROJECTS` (default `FSM`), `AGENT_DASH_RECENT_DAYS` (default 14), `JIRA_SERVER`, `JIRA_LOGIN`, `JIRA_API_TOKEN`.

## Develop

```bash
pnpm test       # node:test, no build step: Node runs the TypeScript directly
pnpm typecheck
```

Node 24 or later is needed, for its built-in TypeScript type stripping.
