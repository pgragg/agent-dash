# agent-dash

A local dashboard for one person who oversees many coding agents at the same time.
It answers one question: **what do I look at next?**

**The goal: one place for the whole developer workflow.** You find the next task, start agents, talk to them, and follow their PRs on this page, so you do not switch between iTerm and agent-dash. Each new feature moves one more step of the workflow from the terminal onto the page.

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

The navbar at the top switches between the views: **Board** (`#/`, the queue and workspace below), **Actions** (`#/actions`), **PRs** (`#/prs`) and **History** (`#/history`). A conversation has its own page (`#/c:<sessionId>`). Each object has its own [address](#addresses).

### Board

- **Left: the queue.** One entry per ticket (or per ticket-less run or PR), ranked by its most urgent signal (see [Queue ranking](#queue-ranking)). Under it: **Waiting on others** (only context left, such as a PR out for review), **Done in Jira** (closed tickets that still have agents open, tagged green **done**; never in the queue), **Agents at work**, **Done for now**, and **Quiet tickets** (your tickets with nothing going on). An entry with several signals shows the most urgent one, with the others as tags: for example "Agent is waiting on you" with **in review**.
- **Right: a workspace for the selected entry.** In order: why the entry is in the queue, the drafted [next steps](#next-steps-summaries), **Start a new agent**, your notes, each live agent's whole last message with a reply box, the PRs, and the run history.
- **Done for now** (`E`) hides an entry until one of its signals changes, so the queue works like an inbox. It is saved in the browser's localStorage.
- **Notes**: each ticket's workspace has a private, timestamped notes list (`N`). Notes are saved in SQLite (`notes` table: `ticket`, `created_at`, `body`) and never leave your machine, except that a next-steps draft reads them first and trusts them over older sources. A note newer than the draft marks it **out of date**.
- **Resolve a thread**: **Resolve** on an agent card or a history row says "this pi thread no longer matters to this ticket", with an optional reason. A resolved thread moves to **Resolved** under the ticket's history, with its reason, and **Mark relevant** undoes it. A resolved thread no longer puts the ticket in the queue or shows as its agent, and next-steps drafts see only its name and reason. If it still waits for you and is resolved for all its tickets, it shows in the queue on its own.
- **Start a new agent** (`A`): type the first message, pick the folder, and **Start agent** opens a new iTerm tab running `pi --name "<KEY>: …" @context.md "<your message>"`. The context file holds what the page shows: your notes, the drafted next steps and their date, the PRs, the latest message from each relevant agent, and the run history (title, start, prompts, status, resolved or relevant). **What the agent gets** previews it. The folder you pick here is also the folder of the **Start agent** buttons in the next steps. Context files stay in `~/.agent-dash/handoffs/`. The context sits between `[agent-dash context for KEY]` markers, and the session parser counts only that key, so the tickets and PRs it mentions do not link the new run to them.
- **History** (`#/history`): every pi chat on this machine, newest first, grouped by day, with no time window. The search box matches every word against the name, first prompt, last reply, folder and tickets. Click a chat to read it: your prompts and the agent's replies, without tool traffic, the newest 40 first. A live chat reloads as it changes. `GET /api/history` gives the list (without each run's whole last message, to keep it small), and `GET /api/transcript?session=<id>` gives one chat. The server finds the log by session id from its own scan, and never takes a path from the page.
- **Notifications**: **Turn on notifications** in the top bar asks Chrome for permission. After that, the page sends a notification when an agent that worked for 45 s or more starts to wait for you, unless you stopped it with Esc. A click opens that run's entry on the board. They need the page open in a tab (in the background is fine), and an exact status from the extension: a status guessed from the log never notifies. **Notifications on** mutes them (saved in localStorage). If Chrome shows nothing, allow notifications for Google Chrome in macOS System Settings → Notifications. They replace the old `notify-on-wait` pi extension, which asked macOS for a notification from the terminal.
- **New conversation** (`C`), at the top of the queue, opens a new page (`#/c`). Type the first message and pick the folder (default `~`), and **Start** runs a plain pi with no ticket and no context file. That pi has no terminal: the page goes to `#/c:<sessionId>`, and you talk to the agent there (see [Conversations on the page](#conversations-on-the-page)).
- **Keyboard**: `J`/`K` move, `E` done for now, `R` reply, `N` note, `A` new agent, `C` new conversation, `O` open the iTerm tab (or the page of a conversation), `S` draft next steps, `⌘↵` send, `?` help.
- `#/t:FSDK-123` or `#/r:<sessionId>` in the URL selects an entry. See [Addresses](#addresses) for the other objects.

### Actions

One short list of what to do next, first to do first. It has two kinds of action:

- **Signals** from the queue that need you: an agent waits, CI is red, a ticket is overdue, and so on. Context only signals (a healthy PR out for review) are not actions.
- **Drafted next steps** of each open ticket, from its newest finished summary. They come after the signals, and each ticket's first step comes before any second step.

Each row shows the action, its ticket (which opens the ticket on the board), how long the action has been on the list ("added 3 hours ago"), and a button that opens the object to act on, in agent-dash: the agent card (`#/r:`), the step (`#/step:`), the ticket (`#/t:`), or the PR on the PRs view (`#/pr:`). The age is a link to the action itself (`#/a:<id>`).

Each action is a row in the SQLite `actions` table. The server syncs the table on each dashboard load: a new action gets a row, and an action that went away gets `cleared_at`. If it comes back later, it gets a new row, so its age starts again. A source that could not be read (for example a GitHub timeout) clears none of its actions. A next step's row dates from when its summary was saved.

### PRs

Your open PRs, grouped by ticket. A PR links to a ticket as on the board, so a PR with no key in its title or branch takes the ticket of the run that opened it. A PR that names two tickets shows under both. The groups with the most urgent PR come first, in the [queue ranking](#queue-ranking) order, and PRs with no ticket come last. Under each PR, the signals that need you (for example "CI is red") show with the reason. The ticket title opens that ticket on the board. Only PRs updated in the last 14 days show, because the GitHub fetch uses that window. The keyboard shortcuts work only on the board.

## Addresses

Every object in agent-dash has an address in the URL hash. A link opens the object and flashes it. The rules are in `web/src/routes.ts`.

| Hash | Opens |
|---|---|
| `#/t:FSDK-123` | The ticket on the board |
| `#/r:<sessionId>` | The run: its agent card or history row, under its ticket. A run with no ticket is its own entry. |
| `#/step:<id>` | A drafted next step, in its ticket's Next steps card |
| `#/note:<id>` | A note, in its ticket's Notes card |
| `#/pr:<owner>/<repo>/<number>` | The PR on the PRs view |
| `#/a:<id>` | The action on the Actions view |
| `#/c:<sessionId>` | The conversation's page |

An object that is not on the page any more (an old run, a merged PR, a cleared action) shows a note that says so.

## Conversations on the page

`POST /api/conversations` (body `{message, cwd}`, with the `X-Agent-Dash` guard) starts `pi --mode rpc --session-id <uuid>` in the folder. The server picks the session id, so the page can open the conversation before pi writes anything.

- **The first message and each reply** go through the [reply inbox](#reply-to-an-agent), as for a terminal session. The status extension delivers them in rpc mode too, and records `mode: "rpc"` in the status file.
- **The page** shows the chat (prompts and replies, no tool traffic), the status, and a reply box. It reloads on each change. Until pi saves the first message, it says "Starting pi…".
- **A restart of the server does not stop a conversation.** rpc mode exits when its stdin ends, so stdin is a FIFO that the pi process opens read-write: `~/.agent-dash/conversations/<id>.in`. The output goes to `<id>.log` next to it.
- **End conversation** (`POST /api/conversations/end?session=<id>`) stops the pi process with SIGTERM. The server takes the pid from the status file, and stops only a session in rpc mode. A terminal pi is closed from its tab. After the end, **Copy resume** continues the chat in a terminal.
- A conversation is a normal pi session, so it also shows on the board and in History. Its **Open** button goes to its page, not to iTerm.
- **Limit:** a dialog from an extension (`ctx.ui.select`, `confirm`, `input`) gets no answer on the page. It waits until its timeout, or for ever if it has none.

## Storage

Everything you write lives in SQLite at `~/.agent-dash/agent-dash.db`:

| Table | Rows |
|---|---|
| `summaries` | One per next-steps request: `ticket`, `status`, `requested_at`, `generated_at`, `summary`, `error` |
| `next_steps` | One per numbered step of a finished summary: `summary_id`, `ticket`, `position`, `body`. Written when the summary is saved. |
| `notes` | One per note: `ticket`, `created_at`, `body` |
| `actions` | One per action on the Actions view: `key` (what it is about, such as `ci_failing pr:<url>`), `kind`, `ticket`, `created_at`, `cleared_at` (set when it goes away) |
| `exits` | One per time you leave the dash for another tool: `at`, `kind`, `host`, `view`, `section`, `ticket`. Append-only. See [Exits](#exits). |
| `PiConversationStatusChange` | One per change to a thread's relevance: `ticket`, `session_id`, `status` (`relevant` or `resolved`), `reason` (resolved only, optional), `created_at`. Append-only; the newest row per ticket and thread is the current state. |

## Reply to an agent

`POST /api/reply?session=<id>` writes the text to `~/.agent-dash/inbox/<sessionId>/<n>.txt`. The status extension in that session watches the folder, and sends each file to the agent as your message with `pi.sendUserMessage`. While the agent works, the message waits until the agent finishes.

The server takes a reply only for a live session whose status file says `inbox: true`: a terminal (tui) session, or a [conversation on the page](#conversations-on-the-page) (rpc). A `pi -p` run does not watch an inbox. A session that started before the extension changed needs `/reload` once; until then, its card says so.

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

A live run shows **Open in iTerm** (`O` for the selected entry's main run). A live conversation that the page started shows **Open**, which goes to its page. A finished run shows **Copy resume**, which copies `cd <cwd> && pi --session <id>`.

- The extension records the iTerm2 session uuid from `ITERM_SESSION_ID`.
- `POST /api/focus?session=<id>` reads the uuid from the status file, never from the request. Then it runs an AppleScript that selects the window, tab and pane, and activates iTerm2.
- The endpoint needs an `X-Agent-Dash: 1` header. That forces a CORS preflight, which the server never answers, so another web page cannot call it.
- **macOS permission:** the app that started the server needs Automation access to iTerm2. If `dash` started it in iTerm, turn on **System Settings → Privacy & Security → Automation → iTerm → iTerm2**. Without it the button says so, and offers the resume command.
- Runs that started before the extension was installed have no tab id until you type `/reload` in them.

## Exits

Each link out of the dash is a sign of a missing view or verb. The dash counts these exits, so the next work replaces the most-used ones. The data stays on this machine, in the `exits` table.

| Kind | Counted when you |
|---|---|
| `github_pr` | open a GitHub PR link |
| `jira` | open a Jira link |
| `slack` | open a Slack link |
| `other_url` | open any other external link |
| `copy_resume` | click **Copy resume** |
| `iterm_focus` | bring an iTerm tab to the front, with the button or `O` |

- One capturing click listener in `web/src/exits.ts` sees every external link (`target="_blank"`), also a middle-click. It reads the view from the URL hash, and the section from the nearest known class (for example `workspace header`, `pr row`, `agent message`, `next steps`). The ticket is the selected ticket, else the key link of the area clicked, else the key in the link.
- The page posts each exit to `POST /api/exits`. It needs the `X-Agent-Dash: 1` header, takes at most 2 KB, and refuses unknown kinds.
- `POST /api/focus` records `iterm_focus` itself after a good focus, so the `O` key counts too. It has no section.
- `GET /api/exits?days=7` returns the counts by kind and section, most used first.
- `pnpm exits [days]` prints the same ranking from SQLite, also when the server is down:

```
jira · workspace header   · 23
github_pr · agent message · 11
```

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

When a summary is saved, the server splits its **Next steps** list into one `next_steps` row per step (`shared/nextSteps.ts`). Each step on the card has a **Start agent** button. It starts a new agent exactly as **Start a new agent** does, with the same context file and folder, and with a first message that the server writes from the stored step: "Do this next step on KEY…" and the step text.

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
