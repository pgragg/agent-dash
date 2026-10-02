# agent-dash

A local dashboard for one person who oversees many coding agents at the same time.
It answers one question: **what do I look at next?**

It reads your pi session logs, your Jira tickets, and your GitHub PRs. You can act on the answer without leaving the page.

The dashboard never writes to Jira or GitHub. The only thing it sends anywhere is a reply that you type to one of your own pi sessions.

## Run it

```bash
pnpm install
pnpm install-extension   # once: exact run status and replies (see below)
pnpm build && pnpm start # http://127.0.0.1:7777
```

`dash` (in `~/.zshrc`) does the same, and opens Chrome. `pnpm dev` runs the server with `--watch` and Vite on http://127.0.0.1:7778.

## The page

- **Left: the queue.** One entry per ticket (or per ticket-less run or PR), ranked by its most urgent signal (see [Queue ranking](#queue-ranking)). Under it: **Waiting on others** (only context left, such as a PR out for review), **Done in Jira** (closed tickets that still have agents open, tagged green **done**; never in the queue), **Agents at work**, **Done for now**, and **Quiet tickets** (your tickets with nothing going on). An entry with several signals shows the most urgent one, with the others as tags: for example "Agent is waiting on you" with **in review**.
- **Right: a workspace for the selected entry.** In order: why the entry is in the queue, the drafted [next steps](#next-steps-summaries), each live agent's whole last message with a reply box, the PRs, and the run history.
- **Done for now** (`E`) hides an entry until one of its signals changes, so the queue works like an inbox. It is saved in the browser's localStorage.
- **Notes**: each ticket's workspace has a private, timestamped notes list (`N`). Notes are saved in SQLite (`notes` table: `ticket`, `created_at`, `body`) and never leave your machine, except that a next-steps draft reads them first and trusts them over older sources. A note newer than the draft marks it **out of date**.
- **Resolve a thread**: **Resolve** on an agent card or a history row says "this pi thread no longer matters to this ticket", with an optional reason. A resolved thread moves to **Resolved** under the ticket's history, with its reason, and **Mark relevant** undoes it. A resolved thread no longer puts the ticket in the queue or shows as its agent, and next-steps drafts see only its name and reason. If it still waits for you and is resolved for all its tickets, it shows in the queue on its own.
- **Start a new agent** (`A`): type the first message, pick the folder, and **Start agent** opens a new iTerm tab running `pi --name "<KEY>: …" @context.md "<your message>"`. The context file holds what the page shows: your notes, the drafted next steps and their date, the PRs, the latest message from each relevant agent, and the run history (title, start, prompts, status, resolved or relevant). **What the agent gets** previews it. Context files stay in `~/.agent-dash/handoffs/`. The context sits between `[agent-dash context for KEY]` markers, and the session parser counts only that key, so the tickets and PRs it mentions do not link the new run to them.
- **Keyboard**: `J`/`K` move, `E` done for now, `R` reply, `N` note, `A` new agent, `O` open the iTerm tab, `S` draft next steps, `⌘↵` send, `?` help.
- `#/t:FSDK-123` or `#/r:<sessionId>` in the URL selects an entry.

## Storage

Everything you write lives in SQLite at `~/.agent-dash/agent-dash.db`:

| Table | Rows |
|---|---|
| `summaries` | One per next-steps request: `ticket`, `status`, `requested_at`, `generated_at`, `summary`, `error` |
| `notes` | One per note: `ticket`, `created_at`, `body` |
| `PiConversationStatusChange` | One per change to a thread's relevance: `ticket`, `session_id`, `status` (`relevant` or `resolved`), `reason` (resolved only, optional), `created_at`. Append-only; the newest row per ticket and thread is the current state. |

## Reply to an agent

`POST /api/reply?session=<id>` writes the text to `~/.agent-dash/inbox/<sessionId>/<n>.txt`. The status extension in that session watches the folder, and sends each file to the agent as your message with `pi.sendUserMessage`. While the agent works, the message waits until the agent finishes.

The server takes a reply only for a live interactive session whose status file says `inbox: true`. A `pi -p` run does not watch an inbox. A session that started before the extension changed needs `/reload` once; until then, its card says so.

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

A live run shows **Open in iTerm** (`O` for the selected entry's main run). A finished run shows **Copy resume**, which copies `cd <cwd> && pi --session <id>`.

- The extension records the iTerm2 session uuid from `ITERM_SESSION_ID`.
- `POST /api/focus?session=<id>` reads the uuid from the status file, never from the request. Then it runs an AppleScript that selects the window, tab and pane, and activates iTerm2.
- The endpoint needs an `X-Agent-Dash: 1` header. That forces a CORS preflight, which the server never answers, so another web page cannot call it.
- **macOS permission:** the app that started the server needs Automation access to iTerm2. If `dash` started it in iTerm, turn on **System Settings → Privacy & Security → Automation → iTerm → iTerm2**. Without it the button says so, and offers the resume command.
- Runs that started before the extension was installed have no tab id until you type `/reload` in them.

## Queue ranking

Higher scores come first. An entry ranks by its highest-scoring item. The rules are in `server/attention.ts`.

| Item | Score |
|---|---|
| Live run stopped on an API error | 110 |
| Live run waiting for you | 100, + up to 60 for the time waited, + 30 if it asked a question. ×0.6 if guessed. 35 after 24 h. |
| Your PR: a reviewer asked for changes | 95 |
| Run died on an API error in the last 24 h | 90 |
| Your PR: CI is red | 85 |
| Your PR: merge conflict | 80 |
| Your PR: approved and green, ready to merge | 70 |
| Your PR: out for review with no review activity for 2 days (nudge the reviewer) | 45 |
| Your PR: out for review, healthy (context only: alone, it does not put the ticket in the queue) | 15 |
| Ticket overdue | 60, + days late (up to 20), + priority |
| Ticket due within 2 days | 50, + priority |
| In-progress ticket with no run for 3 days and no open PR | 25, + priority |

Draft PRs score half. A run counts first for a ticket that is still open. Everything on a Done ticket is context only, so a Done ticket never enters the queue. Tickets that are On Hold, Blocked, Waiting or Deferred score 25 less.

## Next-steps summaries

The **Next steps** card on a ticket's workspace starts a headless pi run (**Draft next steps**, or `S`) that writes a very short summary for the ticket: its state, 1 to 4 next steps with who acts, and its blockers.

1. The server adds an `in_progress` row to SQLite (`~/.agent-dash/agent-dash.db`, table `summaries`) with the ticket and `requested_at`.
2. It writes `~/.agent-dash/summaries/<id>/context.md` with what it already knows: your notes on the ticket, ticket fields, linked PRs, and a digest of each pi session about the ticket (prompts and replies, no tool output, newest first within a 60k-character budget).
3. It starts `pi -p --no-extensions --tools read,bash --session-dir ~/.agent-dash/summary-sessions`. The separate session folder keeps summary runs out of the ticket's run list. The prompt is read-only, and tells the run to read the context, then `jira issue view --comments`, `gh pr view --comments`, and `scripts/slack-search.ts`.
4. The run saves its summary with `node scripts/save-summary.ts <id> < summary.md`. That sets `status = done` and `generated_at`.

| State of the card | Meaning |
|---|---|
| Draft next steps | No summary yet |
| Reading Jira, PRs, Slack… 1m 12s | A run is in progress. The last finished summary stays readable meanwhile. |
| drafted 12m ago · Redraft | The summary. **out of date** shows when a run or PR changed after it was written. |
| probably stuck · Start again | In progress for more than 30 minutes. Start again stops the old run and starts a new one. |
| The last draft failed · Retry | The run ended without a summary. |

If a run exits without saving, the server takes its last reply (pi -p prints it) as the summary. If there is no reply, it marks the row failed. The server also stops a run after 30 minutes. Runs are detached and write to log files, so a server restart does not stop them. On the next page load, the server checks rows whose pid is gone.

`scripts/slack-search.ts "<query>"` searches Slack read-only. It opens Slack once with the saved login in `~/pi/secrets/slack/` and calls Slack's `search.messages` from inside the page, because clicking through the search box from a headless browser is unreliable.

Optional: `AGENT_DASH_SUMMARY_MODEL` and `AGENT_DASH_SUMMARY_THINKING` choose the model and thinking level of summary runs.

## Configuration

Environment variables, all optional: `AGENT_DASH_PORT`, `AGENT_DASH_SESSIONS_DIR`, `AGENT_DASH_STATUS_DIR`, `AGENT_DASH_INBOX_DIR`, `AGENT_DASH_PROJECTS` (default `FSDK|EFSUP`), `AGENT_DASH_EXCLUDE_PROJECTS` (default `FSM`), `AGENT_DASH_RECENT_DAYS` (default 14), `JIRA_SERVER`, `JIRA_LOGIN`, `JIRA_API_TOKEN`.

## Develop

```bash
pnpm test       # node:test, no build step: Node runs the TypeScript directly
pnpm typecheck
```

Node 24 or later is needed, for its built-in TypeScript type stripping.
