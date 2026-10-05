# agent-dash

A local dashboard for one person who oversees many coding agents at the same time.
It answers one question: **what do I look at next?**

**The goal: one place for the whole developer workflow.** You find the next task, start agents, talk to them, and follow their PRs on this page, so you do not switch between iTerm and agent-dash. Each new feature moves one more step of the workflow from the terminal onto the page.

It reads your pi session logs, your Jira tickets, and your GitHub PRs. You can act on the answer without leaving the page.

The dashboard writes one thing to Jira itself: a due date that you set on the [Ticket](#the-ticket-section) section. It never writes to GitHub. The other things it sends go to your own pi sessions: a reply that you type, a Stop, and the answer to an extension dialog. A verb button (a [PR verb](#pr-verbs), or **Move to** on the [Ticket](#the-ticket-section) section) starts an agent on one small task, and that agent does the write: the click is your approval.

## Run it

```bash
pnpm install
pnpm install-extension   # once: exact run status and replies (see below)
pnpm build && pnpm start # http://127.0.0.1:7777
```

`dash` (in `~/.zshrc`) does the same, and opens Chrome. `pnpm dev` runs the server with `--watch` and Vite on http://127.0.0.1:7778.

## The page

The navbar at the top switches between the views: **Board** (`#/`, the queue and workspace below), **Actions** (`#/actions`), **PRs** (`#/prs`), **History** (`#/history`) and **Diagrams** (`#/diagrams`). A conversation has its own page (`#/c:<sessionId>`), and so does each diagram (`#/d:<id>`). Each object has its own [address](#addresses).

### Board

- **Left: the queue.** One entry per ticket (or per ticket-less run or PR), ranked by its most urgent signal (see [Queue ranking](#queue-ranking)). Under it: **Waiting on others** (only context left, such as a PR out for review), **Done in Jira** (closed tickets that still have agents open, tagged green **done**; never in the queue), **Agents at work**, **Done for now**, and **Quiet tickets** (your tickets with nothing going on). An entry with several signals shows the most urgent one, with the others as tags: for example "Agent is waiting on you" with **in review**.
- **Right: a workspace for the selected entry.** In order: the [SDLC progress bar](#sdlc-progress-and-smoketests), why the entry is in the queue (each PR signal with its [verb button](#pr-verbs)), the [Ticket](#the-ticket-section) section, the drafted [next steps](#next-steps-summaries), the [Smoketests](#sdlc-progress-and-smoketests), **Start a new agent**, your notes, each live agent's whole last message with a reply box (see [Live control](#live-control)), the PRs, and the run history. **Show the conversation** on an agent card shows the whole chat in the card (prompts and replies, no tool traffic), so you can read an agent on the board or on its page.
- **Queue or Kanban** (`V`): the toggle at the top of the board picks the layout, and the browser keeps your choice in localStorage. **Kanban** shows the same entries as cards, in one column per [SDLC stage](#sdlc-progress-and-smoketests), then a **No ticket** column. A card sits in the column of the furthest stage that its ticket reached, and each column keeps the queue order. Done for now, snoozed and quiet entries are dimmed. A click on a card (or `↵`) opens its workspace in a drawer over the columns, and `Esc` closes it. The column uses only the PRs on the board (yours, from the last 14 days), so a PR by someone else does not move the card, but the progress bar in the workspace shows it.
- **Done for now** (`E`) hides an entry until one of its signals changes, so the queue works like an inbox. It is saved in the browser's localStorage.
- **Snooze** (`Z`) hides a ticket from the whole board until a time you pick, for a ticket that needs a follow-up later. Pick the time in the list next to the button: 1 hour, 4 hours, tomorrow at 9:00 (the default), 3 days, next Monday at 9:00, 1 week, 2 weeks, or a date. Options of a day or more come back at 9:00 local time. Unlike **Done for now**, a new signal does not bring the ticket back early. Snoozed tickets show under **Snoozed** in the rail, with their time, and **Unsnooze** brings one back now. The time is saved in SQLite (`tickets.snoozed_until`); `POST /api/snooze?ticket=KEY` with `{until}` sets it, and `{until: null}` clears it.
- **Notes**: each ticket's workspace has a private, timestamped notes list (`N`). Notes are saved in SQLite (`notes` table: `ticket`, `created_at`, `body`) and never leave your machine, except that a next-steps draft reads them first and trusts them over older sources. A note newer than the draft marks it **out of date**.
- **Resolve or unlink a thread**: **Resolve** on an agent card or a history row says "this pi thread no longer matters to this ticket". It asks for no reason. A resolved thread moves to **Resolved** under the ticket's history, and **Mark relevant** undoes it. A resolved thread no longer puts the ticket in the queue or shows as its agent, and next-steps drafts see only its name. **Unlink**, next to it, says "this thread has nothing to do with this ticket" (for example, it only mentioned the key). The thread leaves the ticket as if it never named the key: it is not in the ticket's history, its context, or its drafts, and a PR that it opened leaves too, unless the PR names the key. A thread that waits for you and is resolved or unlinked for all its tickets shows in the queue on its own. `POST /api/threads?ticket=KEY&session=ID` (body `{status: "resolved" | "unlinked" | "relevant"}`) sets the state; `relevant` undoes an unlink, and the page has no button for that.
- **Start a new agent** (`A`): type the first message, pick the folder, and **Start agent** starts a headless pi (`pi --mode rpc --name "<KEY>: …"`, see [Conversations on the page](#conversations-on-the-page)). You talk to it on its agent card or on its page (`#/c:<sessionId>`). rpc mode takes no `@file`, so the first message is the context, then your message. Tick **in iTerm** to open a new iTerm tab instead, running `pi --name "<KEY>: …" @context.md "<your message>"`. `POST /api/agents?ticket=KEY` (body `{message, cwd}`, plus `terminal: true` for iTerm) answers `{ok, contextFile, sessionId}`; in iTerm there is no `sessionId`. The context holds what the page shows: your notes, the drafted next steps and their date, the PRs, the latest message from each relevant agent, and the run history (title, start, prompts, status, resolved or relevant). **What the agent gets** previews it. The folder you pick here is also the folder of the **Start agent** buttons in the next steps. Context files stay in `~/.agent-dash/handoffs/`. The session name carries the key, so the run links to the ticket at once. The context sits between `[agent-dash context for KEY]` markers, and the session parser counts only that key, so the tickets and PRs it mentions do not link the new run to them.
- **History** (`#/history`): every pi chat on this machine, newest first, grouped by day, with no time window. The search box matches every word against the name, first prompt, last reply, folder and tickets. Click a chat to read it: your prompts and the agent's replies, without tool traffic, the newest 40 first. A live chat reloads as it changes. `GET /api/history` gives the list (without each run's whole last message, to keep it small), and `GET /api/transcript?session=<id>` gives one chat. The server finds the log by session id from its own scan, and never takes a path from the page.
- **Notifications**: **Turn on notifications** in the top bar asks Chrome for permission. After that, the page sends a notification when an agent that worked for 45 s or more starts to wait for you, unless you stopped it with Esc. A click opens that run's entry on the board. They need the page open in a tab (in the background is fine), and an exact status from the extension: a status guessed from the log never notifies. **Notifications on** mutes them (saved in localStorage). If Chrome shows nothing, allow notifications for Google Chrome in macOS System Settings → Notifications. They replace the old `notify-on-wait` pi extension, which asked macOS for a notification from the terminal.
- **New conversation** (`C`), at the top of the queue, opens a new page (`#/c`). Type the first message and pick the folder (default `~`), and **Start** runs a plain pi with no ticket and no context file. That pi has no terminal: the page goes to `#/c:<sessionId>`, and you talk to the agent there (see [Conversations on the page](#conversations-on-the-page)).
- **Keyboard**: `J`/`K` move, `E` done for now, `Z` snooze, `R` reply, `N` note, `A` new agent, `C` new conversation, `O` open the iTerm tab (or the page of a conversation), `S` draft next steps, `T` show or hide the ticket section, `V` queue or kanban, `⌘↵` send, `?` help. On the PRs and History views, `J`/`K` select a row and `↵` opens it (the PR, or the chat).
- **Fix login**: when Jira or GitHub is down, the top bar shows **Fix Jira login** or **Fix GitHub login**. It runs `~/pi/auth/pi-auth ensure <target>` on the server (`POST /api/login?source=jira|github`, with the `X-Agent-Dash` guard), then refreshes. The target comes from a fixed list, never from the request. pi-auth can open your Chrome; it changes nothing remote. If pi-auth has no target for the source, the button tells you how to log in by hand.
- `#/t:FSDK-123` or `#/r:<sessionId>` in the URL selects an entry. See [Addresses](#addresses) for the other objects.

### Needs you

A click on **N things need you** in the top bar opens `#/needs`: the same N entries as **Up next** on the board, in the same order. "Done for now" entries are not on it. Each row shows:

- **What it is**: the most urgent signal and its reason, for example "Agent is waiting on you", with the other signals as tags.
- **Its ticket**: the key (it opens the ticket on the board) and the title, or "no ticket" and the run or PR name.
- **The next step in agent-dash**: one button that opens the place to act. An agent signal opens the agent card (`#/r:`), a PR signal opens the [PR panel](#pr-panel) with its [verb button](#pr-verbs) next to it, **Overdue** and **Due soon** open the ticket (its "why" list has **New due date…**), and **Stalled** opens the drafted step (`#/step:`), else the ticket. The ticket's first drafted next step also shows under the row.

The rules are in `web/src/needs.ts`.

### Actions

One short list of what to do next, first to do first. It has two kinds of action:

- **Signals** from the queue that need you: an agent waits, CI is red, a ticket is overdue, and so on. Context only signals (a healthy PR out for review) are not actions.
- **Drafted next steps** of each open ticket, from its newest finished summary. They come after the signals, and each ticket's first step comes before any second step.

Each row shows the action, its ticket (which opens the ticket on the board), how long the action has been on the list ("added 3 hours ago"), and a button that opens the object to act on, in agent-dash: the agent card (`#/r:`), the step (`#/step:`), the ticket (`#/t:`), or the [PR panel](#pr-panel) (`#/pr:`). The age is a link to the action itself (`#/a:<id>`).

Each action is a row in the SQLite `actions` table. The server syncs the table on each dashboard load: a new action gets a row, and an action that went away gets `cleared_at`. If it comes back later, it gets a new row, so its age starts again. A source that could not be read (for example a GitHub timeout) clears none of its actions. A next step's row dates from when its summary was saved.

### PRs

Your open PRs, grouped by ticket. A PR links to a ticket as on the board, so a PR with no key in its title or branch takes the ticket of the run that opened it. A PR that names two tickets shows under both. The groups with the most urgent PR come first, in the [queue ranking](#queue-ranking) order, and PRs with no ticket come last. Under each PR, the signals that need you (for example "CI is red: lint, test") show with the reason and a [verb button](#pr-verbs). The ticket title opens that ticket on the board. A click on a PR row, here or on the board, opens the [PR panel](#pr-panel); the small `↗` at the end of the row opens GitHub. The CI tag of a red PR names the failing checks. Only PRs updated in the last 14 days show, because the GitHub fetch uses that window. `J`/`K` select a PR, and `↵` opens it.

### PR panel

`#/pr:<owner>/<repo>/<number>` shows one PR without GitHub. It shows:

- The title, state, author, branches, review decision, and the PR's signals, each with its [verb button](#pr-verbs).
- The tickets in the title or branch (each opens `#/t:KEY`), and the run that opened the PR with `gh pr create`.
- Each unresolved review thread (of the first 100): the file and line, and each comment with its author.
- Each check run and status context (the first 100) with its state, failures first. A failed GitHub Actions check shows the end of its job log, up to the last `##[error]` line (at most 40 lines, 4,000 characters, 3 logs).
- The description (as markdown), the diffstat, and the changed files with their `+`/`−` counts (the first 100).

The page loads it from `GET /api/pr?ref=<owner>/<repo>/<number>` (`server/routes/pr.ts`), with the `X-Agent-Dash` guard, because each request runs `gh` with your login. The server checks that the ref is an owner, a repo and a number, and nothing else. It keeps only the last 256 KB of a job log in memory. It reads the PR with `gh api graphql` and the logs with `gh api`, with your `gh` login, and keeps each answer for 60 s. **Refresh** on the panel skips that cache. It is not part of `/api/dashboard`, so the board stays small.

### PR verbs

Each PR signal has one verb button: on the board's "why" list, under a PR on the PRs view, and on the PR panel. A verb starts an agent with a first message from `shared/prVerbs.ts`, which tells the agent to read the fresh state with `gh` and to do one small task. The click is the approval for that task. Hover over the button to read the message.

| Signal | Verb | The agent… |
|---|---|---|
| CI is red | **Fix CI** | reads the failed log, checks out the PR branch in a clone of the repo, fixes it, runs the checks, and pushes a new commit. Never force-pushes. |
| Changes requested | **Address review** | reads the unresolved threads, fixes each one, and pushes. Posts nothing on GitHub: it drafts a reply per thread and shows them to you. |
| Merge conflict | **Rebase** | checks `git rev-parse --is-shallow-repository` first, merges the base branch in, resolves the conflicts, and pushes. |
| Approved and green | **Merge** | checks the PR is still ready, then runs `gh pr merge` with the repo's default method. The button asks you to confirm first, because a merge cannot be undone. |
| Stale review | **Draft a nudge** | drafts a one-paragraph reminder for the reviewers, and does not post it. |

A PR with a ticket on the board starts a ticket agent (`POST /api/agents?ticket=KEY`, with the ticket's context file). A PR with no such ticket starts a [conversation on the page](#conversations-on-the-page) (`POST /api/conversations`). The folder is the one of the run that opened the PR, because that is the clone with the branch. If no run opened it, the folder is the ticket's newest one, as in **Start a new agent**, else `~`.

### Links in agent messages

A GitHub PR link in a message opens the PR panel, and a Jira link to a ticket on the board opens the ticket (`#/t:KEY`). A small `↗` next to each of these links still opens GitHub or Jira. Other links open as before, in a new tab.

### The ticket section

The **Ticket** section under the workspace header is closed at first. A click or `T` opens it, and the page then reads the ticket from Jira: the description and the 10 newest comments. `GET /api/ticket?key=KEY` (with the `X-Agent-Dash` guard, because each call can reach Jira with your token) makes three read-only GETs (`/rest/api/3/issue/KEY`, its `/comment` list, and its `/transitions`), turns Jira's rich text (ADF) into markdown (`shared/adf.ts`), and caches the answer for 2 minutes. **Reload** reads it again. The `KEY ↗` link and the `↗` in the section still open the ticket in Jira.

The section also has two **Jira verbs**. Your click is the approval of that one change.

- **Move to**: the statuses that Jira's transitions list offers now. The click starts a new agent (`POST /api/agents?ticket=KEY`, as **Start a new agent** does) with a first message from `shared/jiraVerbs.ts`, which tells the agent to use the `jira-tickets` skill and to make that one change and nothing else. A status transition needs no further approval, so the agent applies it.
- **Set due date**: the date picker starts two weeks out. **Set** changes the due date in Jira at once, with no agent: `POST /api/ticket/due?key=KEY` (body `{date, from}`, with the `X-Agent-Dash` guard) reads the ticket's due date, and makes one `PUT /rest/api/3/issue/KEY` with only `duedate`. `from` is the due date that the page showed. If Jira holds another one now, the server changes nothing and answers 409, because your click did not approve replacing a date that you did not see. The board shows the new date at once, without a new Jira search.

An **Overdue** or **Due soon** line in the "why" list has a **New due date…** button that does the same as **Set due date**.

### SDLC progress and smoketests

A progress bar at the top of each ticket shows where its change is on the way to prod. The order is a recommendation, not a gate: when a later stage is done or skipped, the open stages before it show as **skipped**. The rules are in `shared/sdlc.ts`.

| Stage | Done when | Source |
|---|---|---|
| 1. Ideation | Always | — |
| 2. PR exists | An open or merged PR names the key | GitHub |
| 3. Local smoketest | The newest smoketest tagged `localhost` did not fail (skipped if it is a skip) | SQLite |
| 4. In Beta | A deploy event tagged Postman Beta or Fern Dev | SQLite: an agent confirmed it in Argo, or you checked it off |
| 5. Beta smoketest | The newest smoketest tagged Postman Beta or Fern Dev did not fail | SQLite |
| 6. In Prod | A deploy event tagged Postman Prod or Fern Prod | SQLite, as In Beta |
| 7. Prod smoketest | The newest smoketest tagged Postman Prod or Fern Prod did not fail | SQLite |
| 8. Ticket done | The Jira status category is Done | Jira |

- **The PRs** are the ticket's PRs on the board, plus `GET /api/ticket-prs?key=KEY` (with the `X-Agent-Dash` guard): a GitHub search for PRs by anyone, of any age, with the key in the title, cached for 2 minutes. A PR in `postman-eng/cloud9-parcels-deployments` is a Beta deploy PR, and one in `postman-eng/cloud9-parcels-production-deployments` is a Prod deploy PR. When a deploy PR merged and no deploy event exists, the stage shows **waiting**.
- **A click on a stage** shows its state and its actions. At first it shows the next stage, with the hint of what to do: for example, a local smoketest comes before a PR review, and a Beta smoketest comes before the prod chart version update PR.
  - A smoketest stage: **Run smoketest on <environment>** starts an agent (`POST /api/agents?ticket=KEY` with `{sdlc: {kind: "smoketest", env}}`). The server writes the first message (`smoketestMessage` in `shared/sdlc.ts`), because it names the server's own script path. The agent runs the smoketest, then records it with `scripts/sdlc-event.ts`. **Skip smoketest** (until the stage is done or skipped) records a smoketest event with `skippedAt` set to now and no outcome. The stage then shows **skipped**, and the next stage comes after it. Delete the event on the Smoketests card to undo the skip.
  - In Beta and In Prod: **Confirm in Argo** (in any state until the stage is done, also when no deploy PR or earlier stage is seen) starts an agent that checks the Argo app read-only and records a deploy event. **Check off by hand** records it at once, for a change with no Argo deploy. **Undo** removes the newest deploy event.
- **The Smoketests card** lists the ticket's smoketests, newest first, with the time, how long each ran, the environment tags, the outcome, the test details, and the results (closed at first). Pick an environment, then **Run smoketest on …** starts the same agent as on the bar, and **Skip smoketest** records a skip for that environment. **Record by hand** saves a smoketest that you ran yourself. **Delete** removes one.
- **A tag is the environment under test**, not every system that the test touched. A local frontend against the Postman Beta backend tests Beta, so its tag is Postman Beta. Two tags are for the rare test where both sides are under test. The tags are `localhost`, `fern_dev`, `fern_prod`, `postman_beta` and `postman_prod` (or their labels: "Fern Dev" and so on).
- **The next-steps summary and the context of a new agent** both get the progress, one line per stage. The summary prompt tells the run to follow the order, to name the environment when the next stage is a smoketest, and to plan no step for a skipped stage.
- **A new or changed event redrafts the next steps.** When a smoketest, a skip, or a deploy is recorded or changed (on the page or with the script), the server starts a new [next-steps](#next-steps-summaries) draft for each ticket of the event, because the old steps can name a stage that is now done. A change is any `UPDATE` of its `SDLC_Event` row: a SQLite trigger marks the event's tickets for a new draft, so it works for every writer. A draft that is in progress and started before the event was made or changed is stopped and replaced. A ticket that is not on the board gets no draft. A delete does not start a draft.

`POST /api/sdlc-events` (body `{eventType, tickets, environments, startedAt, finishedAt, outcome, testDetails, testResults, skippedAt}`; only a smoketest with no outcome can have `skippedAt`) and `DELETE /api/sdlc-events?id=N` write the events, with the `X-Agent-Dash` guard. An agent uses the script, which writes into the same database:

```bash
node scripts/sdlc-event.ts smoketest --ticket FSDK-1 --env localhost \
  --started 2026-10-05T10:00:00Z --finished 2026-10-05T10:20:00Z --outcome passed \
  --details-file details.md --results-file results.md
node scripts/sdlc-event.ts deploy --ticket FSDK-1 --env postman_beta --details "<Argo app>: Synced, Healthy, 1.2.3"
```

`--ticket` and `--env` can repeat. With no `--started`, the time is now.

## Addresses

Every object in agent-dash has an address in the URL hash. A link opens the object and flashes it. The rules are in `web/src/routes.ts`.

| Hash | Opens |
|---|---|
| `#/t:FSDK-123` | The ticket on the board |
| `#/r:<sessionId>` | The run: its agent card or history row, under its ticket. A run with no ticket is its own entry. |
| `#/step:<id>` | A drafted next step, in its ticket's Next steps card |
| `#/note:<id>` | A note, in its ticket's Notes card |
| `#/pr:<owner>/<repo>/<number>` | The [PR panel](#pr-panel) |
| `#/a:<id>` | The action on the Actions view |
| `#/needs` | The [Needs you](#needs-you) list |
| `#/c:<sessionId>` | The conversation's page. A conversation that is older than the board's window shows its chat from the log. |
| `#/d:<id>` | The [diagram's](#diagrams) page |
| `#/diagrams` | Every diagram |

An object that is not on the page any more (an old run, a merged PR, a cleared action) shows a note that says so.

## Diagrams

The page shows the diagrams and charts that agents make. Three things count, because each one is an agent that shows you a picture on purpose:

| In the log | Diagram |
|---|---|
| A ` ```mermaid ` fence in a reply | Mermaid |
| A `write` of a `.mmd` or `.mermaid` file, or of a markdown file with mermaid fences in it | Mermaid, one per fence |
| A `write` of an `.svg` file | SVG |
| `![title](path)` in a reply, where the path is a local PNG, JPEG, GIF, WebP or SVG file | That image |

A file that the agent only names (a screenshot it read, for example) does not count.

- **Each diagram is a row** in the SQLite `diagrams` table, with a copy of its source (raster images as base64, up to 5 MB). The row has the conversation (`session_id`) and that conversation's main ticket. Its page (`#/d:<id>`) reads only the row, so a diagram opens when its log, its file, or its ticket is gone. If the conversation gets another main ticket later (for example, through a PR), its diagrams move to that ticket.
- **Where it shows**: in each message, a mermaid fence renders as a chart with a "Diagram N" link, and an embedded image shows from its stored copy. A ticket's workspace and a conversation's page have a **Diagrams** section with previews. The **Diagrams** view lists all of them, newest first, with a search box. The diagram page links to its ticket and its conversation, shows its source, and opens its stored file.
- **How it is found**: the session parser collects diagrams with the rest of the log, so it re-reads only the logs that changed. The server reads an embedded image once per change to its file, and checks its first bytes, so a file that is not an image is never stored. The same diagram twice in one conversation is one row (the key is the session id and the SHA-1 of the source). A newer `write` of the same file replaces the diagrams from its older writes, in the page and in SQLite, because the dash does not track `edit`s, so an older write can hold a chart that was fixed later.
- **Fix a mistake**: an agent can draw the wrong thing. On the diagram page, **Edit** changes the title of any diagram, and the source of a mermaid or SVG one, with a live preview (`⌘↵` saves, `Esc` cancels). **Delete** takes the diagram off the board and the list, after you confirm. A deleted row stays in the table with `deleted_at`, so the next scan of the log does not add it again, and its page has **Restore**. An edit keeps the agent's hash, so the fence in the message still links to the row, and its caption says **edited**. The message itself still shows what the agent wrote. A newer write of the same file does not replace a diagram that you edited. `POST /api/diagram?id=N` (with the `X-Agent-Dash` guard) takes `{title?, source?, deleted?}`. An edited SVG must still be an SVG.
- **Safety**: mermaid renders with `securityLevel: "strict"`, and loads only when a diagram shows. `GET /api/diagram/raw?id=N` serves the stored file with `Content-Security-Policy: default-src 'none'; sandbox`, so an SVG that an agent wrote runs no script, even when you open it on its own.

## Conversations on the page

`POST /api/conversations` (body `{message, cwd}`, with the `X-Agent-Dash` guard) starts `pi --mode rpc --session-id <uuid>` in the folder. The server picks the session id, so the page can open the conversation before pi writes anything. A ticket agent from **Start a new agent** starts the same way, with `--name "<KEY>: …"` added.

- **The first message and each reply** go through the [reply inbox](#reply-to-an-agent), as for a terminal session. The status extension delivers them in rpc mode too, and records `mode: "rpc"` in the status file.
- **The page** shows the chat (prompts and replies, no tool traffic), the status, and a reply box. It reloads on each change. Until pi saves the first message, it says "Starting pi…".
- **A restart of the server does not stop a conversation.** rpc mode exits when its stdin ends, so stdin is a FIFO that the pi process opens read-write: `~/.agent-dash/conversations/<id>.in`. The output goes to `<id>.log` next to it.
- **End conversation** (`POST /api/conversations/end?session=<id>`) stops the pi process with SIGTERM. The server takes the pid from the status file, and stops only a session in rpc mode. A terminal pi is closed from its tab.
- **Resume here** (`POST /api/conversations/resume?session=<id>`, with the `X-Agent-Dash` guard) continues a finished session headless: `pi --mode rpc --session <file>`, which keeps the session id. Then the page opens `#/c:<sessionId>`. The server takes the log file from its own scan, never from the request. Two pi processes on one log would mix their entries, so it resumes only a session that is known to be closed: it has a status file, its pid is gone, and this server is not already running it. A session with no status file (it started before the extension) can still be open in a terminal, so it shows only **Copy resume**. **Copy resume** stays, to continue the chat in a terminal.
- A conversation is a normal pi session, so it also shows on the board and in History. Its **Open** button goes to its page, not to iTerm.
- **Extension dialogs** (`ctx.ui.select`, `confirm`, `input`, `editor`) show on the page as a card, and you answer them there. See [Live control](#live-control).
- **Limit:** the page answers a dialog only in a conversation on the page. A dialog in a terminal session shows on its card as "Waiting on a dialog in iTerm", and you answer it in the tab: a tui dialog reads the terminal's keys, and the dash cannot type into it. A dialog that was open when you typed `/reload` drops off the card, but still waits in the session. A pi that started with an extension older than version 2 does not report its dialogs, so they get no answer on the page; they wait until their timeout, or for ever if they have none.

## Storage

Everything you write lives in SQLite at `~/.agent-dash/agent-dash.db`:

| Table | Rows |
|---|---|
| `summaries` | One per next-steps request: `ticket`, `status`, `requested_at`, `generated_at`, `summary`, `error` |
| `next_steps` | One per numbered step of a finished summary: `summary_id`, `ticket`, `position`, `body`. Written when the summary is saved. |
| `notes` | One per note: `ticket`, `created_at`, `body` |
| `tickets` | One per ticket with local state: `key`, `snoozed_until` (when a snoozed ticket comes back to the board) |
| `actions` | One per action on the Actions view: `key` (what it is about, such as `ci_failing pr:<url>`), `kind`, `ticket`, `created_at`, `cleared_at` (set when it goes away) |
| `exits` | One per time you leave the dash for another tool: `at`, `kind`, `host`, `view`, `section`, `ticket`. Append-only. See [Exits](#exits). |
| `diagrams` | One per diagram an agent made: `key` (session id and source hash), `session_id`, `ticket`, `kind`, `title`, `origin` (`reply`, or the file path as the agent wrote it), `hash`, `source`, `created_at` (when the agent wrote it) |
| `SDLC_Event` | One per smoketest or confirmed deploy: `event_type` (`smoketest` or `deploy`), `started_at`, `finished_at`, `outcome` (`passed`, `failed`, or empty), `test_details`, `test_results`, `skipped_at` (set on a smoketest that you skipped), `created_at` |
| `SDLC_Event_Environment` | One per environment under test of an event: `sdlc_event_id`, `environment` |
| `SDLC_Event_Ticket` | One per ticket of an event: `sdlc_event_id`, `ticket`, `created_at` (when the link was made), `summary_requested_at` (when the server started the next-steps draft for it; empty until then, and empty again when the event changes), `changed_at` (when the event last changed; set by the `sdlc_event_changed` trigger) |
| `PiConversationStatusChange` | One per change to a thread's relevance: `ticket`, `session_id`, `status` (`relevant` or `resolved`), `reason` (resolved only, optional), `created_at`. Append-only; the newest row per ticket and thread is the current state. |

## Reply to an agent

`POST /api/reply?session=<id>` writes the text to `~/.agent-dash/inbox/<sessionId>/<n>.txt`. The status extension in that session watches the folder, and sends each file to the agent as your message with `pi.sendUserMessage`. While the agent works, the message waits until the agent finishes.

The server takes a reply only for a live session whose status file says `inbox: true`: a terminal (tui) session, or a [conversation on the page](#conversations-on-the-page) (rpc). A `pi -p` run does not watch an inbox. A session that started before the extension changed needs `/reload` once; until then, its card says so.

## Live control

The status extension writes `"version": 2` in its status file. From version 2, the page can see what a live agent does and control it, so you do not need its iTerm tab. A session that started with an older extension shows "Type /reload in the session for Stop and Steer" instead.

- **Activity**: on `tool_execution_start`, the extension writes the tool, a one-line summary of its arguments and the start time to the status file. The summary is the command for `bash` (cut to 80 characters), the path for `read`, `edit`, `write` and `ls`, and the pattern for `grep` and `find`. Values that look like tokens, keys or passwords, and the password in a URL, show as `***`. The card shows it as "running `pnpm test` · 40s". The extension clears it on `tool_execution_end` and `agent_settled`. It writes at most once every 1.5 s, so a run with many tools does not reload the page many times a second.
- **Stop** (in the reply box, while the agent works or a dialog is open): `POST /api/stop?session=<id>` writes `<n>.abort` to the inbox, and the extension calls `ctx.abort()`, as Esc does. It also closes every open extension dialog (through the dialog's abort signal), so a run that waits on a dialog in iTerm can still be stopped from the page. An editor dialog takes no abort signal: in a conversation on the page, Stop cancels it through the FIFO; in a terminal, the page says to close it in the tab. pi logs a stop during a tool call as an error ("This operation was aborted"); the dash counts it as a stop by you, not an API error.
- **Send after it finishes** or **Steer now** (in the reply box, while the agent works): `POST /api/reply` with `{text, steer: true}` writes `<n>.steer` instead of `<n>.txt`. The extension sends it with `deliverAs: "steer"`: the agent reads it after its current tool calls, before its next model call. A plain reply stays `<n>.txt` (`deliverAs: "followUp"`), so an older extension still takes it. The server refuses a steer for an older extension.
- **Dialogs**: pi has no event for a dialog, so the extension wraps the dialog methods of the shared `ctx.ui` object. While a dialog is open, the status file holds its method, title, message and options. The run then counts as waiting for you, and asked a question, so it goes to the top of the queue. In a [conversation on the page](#conversations-on-the-page), the card shows the options (select), **Yes** / **No** (confirm) or a text box (input, editor), and **Dismiss**. An editor whose text is too long for the status file (over 4000 characters) offers only **Dismiss**, so the page never sends back a cut copy. `POST /api/dialog?session=<id>` (body `{index}` for a select, `{value}`, `{confirmed}` or `{cancelled: true}`) finds the newest unanswered `extension_ui_request` in the end of `<id>.log`, checks that it is the dialog that the status file names, and writes an `extension_ui_response` line to the FIFO `<id>.in` (`server/rpc.ts`). It opens the FIFO without blocking: pi holds it open, and with no reader the open fails at once.

The server listens on `127.0.0.1` only, because the page shows prompts and replies from every session.

## Where the data comes from

| Source | How | Notes |
|---|---|---|
| pi sessions | `~/.pi/agent/sessions/**/*.jsonl` | Re-parses only the files that changed. A cold scan of about 700 sessions takes about 1 s. |
| Run status | `~/.agent-dash/status/<sessionId>.json`, written by `extension/agent-dash-status.ts` | Without it, status is a guess from the log, marked `?` |
| Jira | `POST /rest/api/3/search/jql` with the token in `~/pi/secrets/jira/.env.personal` | Open tickets assigned to you, excluding the deprecated `FSM` project. The [Ticket](#the-ticket-section) section reads one ticket's description, comments and transitions with GETs, only when it opens. |
| GitHub | `gh api graphql` with your `gh` login | Your PRs updated in the last 14 days, with CI (and the names of the failing checks), review, and merge state. The [PR panel](#pr-panel) reads one PR in full on demand. |

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
| awaiting input | `agent_settled` fired, or an extension dialog is open, and the pi process is alive | The log ends on a finished reply less than 4 h old |
| finished | `session_shutdown` fired, or the pid is gone | Everything else |

The extension writes its status file on `agent_settled`, not on `agent_end`, because pi can still retry or run queued messages after `agent_end`.

## Jump to a run's iTerm tab

A live run shows **Open in iTerm** (`O` for the selected entry's main run). A live conversation that the page started shows **Open**, which goes to its page. A finished run with a status file shows **Resume here**, which continues it on its page (see [Conversations on the page](#conversations-on-the-page)), and **Copy resume**, which copies `cd <cwd> && pi --session <id>`.

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

- One capturing click listener in `web/src/exits.ts` sees every external link (`target="_blank"`), also a middle-click. It reads the view from the URL hash, and the section from the nearest known class (for example `workspace header`, `pr row`, `agent message`, `next steps`). The ticket is the selected ticket, else the key link of the PR group, action row or workspace clicked, else the key in the link. A PR group with no ticket records no ticket.
- The page posts each exit to `POST /api/exits`. It needs the `X-Agent-Dash: 1` header, takes at most 2 KB, and refuses unknown kinds.
- `POST /api/focus` records `iterm_focus` itself after a good focus, so the `O` key counts too. It has no section.
- `GET /api/exits?days=7` returns the counts by kind and section, most used first.
- A row keeps the host of the link, never the full URL. Rows are kept until you delete them.
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
| drafted 12m ago · Redraft | The summary. **out of date** shows when a run or PR changed after it was written. A new or changed [SDLC event](#sdlc-progress-and-smoketests) starts a new draft by itself. |
| probably stuck · Start again | In progress for more than 30 minutes. Start again stops the old run and starts a new one. |
| The last draft failed · Retry | The run ended without a summary. |

When a summary is saved, the server splits its **Next steps** list into one `next_steps` row per step (`shared/nextSteps.ts`). Each step on the card has a **Start agent** button. It starts a new agent exactly as **Start a new agent** does (headless; ⌥-click opens it in iTerm), with the same context and folder, and with a first message that the server writes from the stored step: "Do this next step on KEY…" and the step text.

If a run exits without saving, the server takes its last reply (pi -p prints it) as the summary. If there is no reply, it marks the row failed. The server also stops a run after 30 minutes. Runs are detached and write to log files, so a server restart does not stop them. On the next page load, the server checks rows whose pid is gone.

**Slack quotes.** When a summary links to a Slack message, the card shows a closed **Slack** list under the summary with the message text, its channel, its author and the time, so you can read it without going to Slack. The summary run sets `AGENT_DASH_SLACK_HITS`, so `slack-search.ts` also saves each match to `slack.jsonl` in the run's work folder. `GET /api/summaries/slack?id=<id>` returns the saved matches that the summary links to. It takes the folder from the database row, never from the request. A summary from before this change has no saved matches and shows no list.

`scripts/slack-search.ts "<query>"` searches Slack read-only. It opens Slack once with the saved login in `~/pi/secrets/slack/` and calls Slack's `search.messages` from inside the page, because clicking through the search box from a headless browser is unreliable.

Optional: `AGENT_DASH_SUMMARY_MODEL` and `AGENT_DASH_SUMMARY_THINKING` choose the model and thinking level of summary runs.

## Configuration

Environment variables, all optional: `AGENT_DASH_PORT`, `AGENT_DASH_SESSIONS_DIR`, `AGENT_DASH_STATUS_DIR`, `AGENT_DASH_INBOX_DIR`, `AGENT_DASH_CONVERSATIONS_DIR`, `AGENT_DASH_PROJECTS` (default `FSDK|EFSUP`), `AGENT_DASH_EXCLUDE_PROJECTS` (default `FSM`), `AGENT_DASH_RECENT_DAYS` (default 14), `JIRA_SERVER`, `JIRA_LOGIN`, `JIRA_API_TOKEN`, `AGENT_DASH_PI_AUTH` (default `~/pi/auth/pi-auth`).

## Develop

```bash
pnpm test       # node:test, no build step: Node runs the TypeScript directly
pnpm typecheck
```

Node 24 or later is needed, for its built-in TypeScript type stripping.
