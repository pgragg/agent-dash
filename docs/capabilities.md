# What agent-dash can do

A ship's captain stays on the bridge. To change speed, the captain does not run to the engine room. The captain moves the engine telegraph, and the crew below does the work.

A developer who runs many coding agents leaves the bridge all the time: iTerm for the agents, Jira for tickets, GitHub for PRs and CI, Slack for reviews, Argo for deploys. agent-dash brings these controls to one page. You see the state of all your work, and you give each order from the same place. Your agents are the crew.

This page is a short tour. The [README](../README.md) is the full reference.

> The screenshots show fictional tickets, repos and people. They are from 2026-10-07, so some parts look different now: the top bar has one **Needs you** count, the navbar has **Documents** and **Wiki** (not Diagrams and Worktrees), and **Snooze** has the **Until something changes** option that replaced **Done for now**.

## The instruments: what you see

### One ranked queue

There is one entry per ticket, and the most urgent signal puts it first: an agent that waits for you, a red CI run, a review that asks for changes, a due date. The workspace on the right shows the selected ticket, with the parts that you act on first. **Star** a ticket to pin it to the top. **Snooze** hides it until something changes, or until a time that you pick. → [Board](../README.md#board)

![Board: the ranked queue and the workspace of one ticket](images/board.png)

The **Kanban** layout shows the same tickets in columns, one column for each SDLC stage, with a search box. Each card shows its top next step as one button that says what a click does, such as **▶ Move ticket to In Review**. → [The kanban card button](../README.md#the-kanban-card-button)

![Kanban: one column for each SDLC stage](images/kanban.png)

### Agent summaries

Each agent card has three lines: what the conversation is **about**, what the agent said **last**, and what it **needs from you**. You do not have to read the transcript. Reply, steer or stop the agent from the card, and see the tool that it runs now. → [Conversation summaries](../README.md#conversation-summaries), [Live control](../README.md#live-control)

![Agent cards with About, Latest, Needs from you, and a reply box](images/agent-cards.png)

### Drafted next steps and the SDLC route

For each ticket, an agent reads Jira, the PRs, Slack and your notes, then writes the state, the next steps and the blockers. Each step has a **Start agent** button, or **Move to** when the step only moves the ticket. A 12-stage bar shows where the change is on its way from idea to prod, and which stage is next. You can see both in the board screenshot above. → [Next-steps summaries](../README.md#next-steps-summaries), [SDLC progress](../README.md#sdlc-progress-and-smoketests)

### One list of what needs you

The top bar has one count, **Needs you N**: the queue's Up next entries plus the parked agents that still ask something, with each ticket counted one time. Each Up next entry says what the agent needs, and has one button to the place where you act. Chrome notifications come one per ticket, not one per agent. → [Needs you](../README.md#needs-you)

On a ticket, the "why" list under the progress bar has three groups. **Needs you** has each signal that waits on you, with its button. **Parked asks** has each agent of the ticket that agent-dash parked with a question: read what it needs, then **Send** a reply, **Resume** it, or **Dismiss** the ask. **Updates** has the rest. A row that came since you last looked is marked **new**. → [Parked agents](../README.md#parked-agents)

## The controls: what you do from the page

### Start and steer agents

Start an agent with the ticket context already loaded, or open a plain conversation. You talk to it on the page, so you do not need a terminal tab. → [Conversations on the page](../README.md#conversations-on-the-page)

### Smoketests

An agent writes a test plan first. A plan that changes a shared environment waits for your **Confirm**. Each environment shows its plan, its run, and the history of its runs. The same screenshot shows **Start a new agent** and your private notes. → [SDLC progress and smoketests](../README.md#sdlc-progress-and-smoketests)

![Smoketests per environment, Start a new agent, and Notes](images/smoketests.png)

### Tickets

Read the Jira description and comments, move the status, and set a due date. Local ticket files (such as agent-dash's own `AD-` tickets) show on the board too. → [The ticket section](../README.md#the-ticket-section), [Ticket providers](../README.md#ticket-providers)

![Ticket section with Move to and Set due date](images/ticket.png)

Keep the ticket's documentation on its page: markdown with mermaid diagrams and images. Each diagram that an agent draws becomes a document. One click has an agent research the ticket and write a five-minute ticket brief: today and done on one map, where the ticket and reality differ, how to prove it is done, and the open decisions with a recommendation each. **Edit** with a prompt has an agent rewrite a document in place. → [Documentation](../README.md#documents)

### PRs and reviews

See your open PRs by ticket, each with a drafted review request. **Post to Slack** sends it. → [PRs](../README.md#prs)

![PRs view with a drafted Slack review request](images/prs.png)

The PR panel shows feedback, checks (with the end of a failed job log), the description and the files, without GitHub. When a PR needs something, one button starts an agent on it: **Fix CI**, **Address review**, **Rebase**, **Merge** or **Draft a nudge**. → [PR panel](../README.md#pr-panel), [PR verbs](../README.md#pr-verbs)

![PR panel: feedback, tickets and runs, checks, and description](images/pr-panel.png)

### Find past work

**History** lists every chat on this machine, newest first, with a search box, and opens one to read. **Documents** lists every document. **Wiki** searches and opens the notes of your local Obsidian vault, read-only. → [Board](../README.md#board), [Documents](../README.md#documents), [Wiki](../README.md#wiki)

## The safety rules

- It runs on your machine only (`127.0.0.1`). Your notes stay local.
- Each write starts with your click, and the click is your approval. It writes to Jira (a status or a due date) and Slack (a review request) only, and moves a local ticket file into its new status folder. It never writes to GitHub itself: a PR verb starts an agent, and the agent does that one task.
- A smoketest plan that changes a shared environment waits for your **Confirm**.
- At most 15 agents wait for you at one time. agent-dash parks the others and keeps what each one needed, so no question gets lost. → [Parked agents](../README.md#parked-agents)
- When a Jira, GitHub or Slack login expires, the top bar says so, and **Fix login** refreshes it or gives the steps.

## Set it up

Pick **pi**, **Claude Code** or **OpenCode** as the agent. Each setting shows an example and how to find it, or **Set it up for me** starts an agent that finds them. → [Run it](../README.md#run-it), [Configuration](../README.md#configuration)

![Settings: choose the agent, with an example for each setting](images/settings.png)
