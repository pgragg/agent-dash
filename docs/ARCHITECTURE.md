# Agent-Dash Architecture

Agent-dash is a local dashboard for developers who oversee multiple AI coding agents simultaneously. It answers one question: **what do I look at next?**

## High-Level Overview

```mermaid
flowchart TB
    subgraph External["External Services"]
        Jira["Jira<br/>(tickets)"]
        GitHub["GitHub<br/>(PRs & CI)"]
        Slack["Slack<br/>(review requests)"]
    end

    subgraph AgentDash["Agent-Dash System"]
        Server["Node.js Server<br/>:7777"]
        Web["React Web UI"]
        SQLite["SQLite DB<br/>~/.agent-dash/agent-dash.db"]
        Extension["Pi Extension<br/>(status reporting)"]
    end

    subgraph Pi["Pi Coding Agent"]
        Sessions["Session Logs<br/>~/.pi/agent/sessions/"]
        StatusFiles["Status Files<br/>~/.agent-dash/status/"]
        Inbox["Reply Inbox<br/>~/.agent-dash/inbox/"]
    end

    Jira <--> Server
    GitHub <--> Server
    Slack <--> Server
    Server <--> Web
    Server <--> SQLite
    Server --> Sessions
    Extension --> StatusFiles
    Server --> StatusFiles
    Server --> Inbox
    Extension --> Inbox
```

## Data Flow Architecture

```mermaid
flowchart LR
    subgraph Sources["Data Sources"]
        PiLogs["Pi Session Logs<br/>(JSONL files)"]
        StatusExt["Status Extension<br/>(live status)"]
        JiraAPI["Jira API"]
        GitHubAPI["GitHub API"]
    end

    subgraph Server["Server Processing"]
        SessionParser["Session Parser<br/>(sources/sessions.ts)"]
        StatusReader["Status Reader<br/>(sources/status.ts)"]
        JiraFetcher["Jira Fetcher"]
        PRFetcher["PR Fetcher"]
        AttentionCalc["Attention Calculator<br/>(attention.ts)"]
        ModelBuilder["Dashboard Model<br/>(model.ts)"]
    end

    subgraph Output["Dashboard Output"]
        Queue["Queue View<br/>(ranked signals)"]
        Board["Board View<br/>(ticket workspaces)"]
        PRsView["PRs View"]
        History["History View"]
    end

    PiLogs --> SessionParser
    StatusExt --> StatusReader
    JiraAPI --> JiraFetcher
    GitHubAPI --> PRFetcher

    SessionParser --> ModelBuilder
    StatusReader --> ModelBuilder
    JiraFetcher --> ModelBuilder
    PRFetcher --> ModelBuilder

    ModelBuilder --> AttentionCalc
    AttentionCalc --> Queue
    ModelBuilder --> Board
    ModelBuilder --> PRsView
    ModelBuilder --> History
```

## Core Components

### 1. Server (`server/index.ts`)
The HTTP server that:
- Serves the web UI on `http://127.0.0.1:7777`
- Provides REST API endpoints for dashboard data
- Manages caching for external service calls
- Broadcasts changes via Server-Sent Events (SSE)

### 2. Data Sources (`server/sources/`)

```mermaid
flowchart TB
    subgraph sources["server/sources/"]
        sessions["sessions.ts<br/>Parses pi session logs"]
        status["status.ts<br/>Reads extension status files"]
        jira["jira.ts<br/>Fetches Jira tickets"]
        github["github.ts<br/>Fetches GitHub PRs"]
        local["localTickets.ts<br/>Agent-dash's own tickets"]
    end

    subgraph data["Data Extracted"]
        runs["Runs: status, prompts,<br/>replies, tickets, PRs"]
        live["Live Status: working,<br/>awaiting_input, finished"]
        tickets["Tickets: status,<br/>priority, due dates"]
        prs["PRs: review state,<br/>CI status, conflicts"]
    end

    sessions --> runs
    status --> live
    jira --> tickets
    github --> prs
```

### 3. Attention System (`server/attention.ts`)

The attention calculator scores and ranks items that need your attention:

```mermaid
flowchart TB
    subgraph inputs["Inputs"]
        runs["Agent Runs"]
        prs["Pull Requests"]
        tickets["Tickets"]
    end

    subgraph scoring["Scoring Rules (score = priority)"]
        error["Run Error: 110"]
        waiting["Agent Waiting: 100+"]
        changes["Changes Requested: 95"]
        ciRed["CI Red: 85"]
        conflict["Merge Conflict: 80"]
        merge["Ready to Merge: 70"]
        overdue["Ticket Overdue: 60"]
        stalled["Stalled: 50"]
        review["In Review: 15-45"]
    end

    subgraph output["Output"]
        queue["Ranked Queue"]
    end

    runs --> error
    runs --> waiting
    prs --> changes
    prs --> ciRed
    prs --> conflict
    prs --> merge
    tickets --> overdue
    tickets --> stalled
    prs --> review

    error --> queue
    waiting --> queue
    changes --> queue
    ciRed --> queue
    conflict --> queue
    merge --> queue
    overdue --> queue
    stalled --> queue
    review --> queue
```

### 4. Extension System (`extension/agent-dash-status.ts`)

The pi extension enables bidirectional communication with live agents:

```mermaid
sequenceDiagram
    participant Pi as Pi Agent
    participant Ext as Status Extension
    participant Status as Status File<br/>(~/.agent-dash/status/)
    participant Inbox as Inbox Folder<br/>(~/.agent-dash/inbox/)
    participant Server as Agent-Dash Server
    participant Web as Web UI

    Note over Ext: On agent_running
    Ext->>Status: Write {state: "working", tool, activity}
    Server->>Status: Read status
    Server->>Web: SSE: agent working

    Note over Ext: On agent_settled
    Ext->>Status: Write {state: "awaiting_input"}
    Server->>Status: Read status
    Server->>Web: SSE: agent waiting

    Note over Web: User sends reply
    Web->>Server: POST /api/reply
    Server->>Inbox: Write <n>.txt
    Ext->>Inbox: Watch folder
    Ext->>Pi: ctx.sendUserMessage(text)

    Note over Web: User clicks Stop
    Web->>Server: POST /api/stop
    Server->>Inbox: Write <n>.abort
    Ext->>Inbox: Watch folder
    Ext->>Pi: ctx.abort()
```

## Web UI Architecture

```mermaid
flowchart TB
    subgraph views["Views (URL Hash Routes)"]
        board["#/ Board<br/>Queue + Workspace"]
        actions["#/actions<br/>Action List"]
        prsView["#/prs<br/>PR List"]
        history["#/history<br/>Chat History"]
        diagrams["#/diagrams<br/>Agent Diagrams"]
        conv["#/c:sessionId<br/>Conversation"]
    end

    subgraph components["Key Components"]
        queue["Queue<br/>Ranked entries"]
        workspace["Workspace<br/>Ticket details"]
        agentCard["Agent Card<br/>Summary + Reply"]
        prPanel["PR Panel<br/>Details + Verbs"]
        sdlc["SDLC Bar<br/>Progress stages"]
    end

    board --> queue
    board --> workspace
    workspace --> agentCard
    workspace --> prPanel
    workspace --> sdlc
```

## Ticket-Centric Model

Everything links to tickets:

```mermaid
flowchart TB
    ticket["Ticket<br/>(from Jira)"]
    
    runs["Agent Runs<br/>(via session name<br/>or PR link)"]
    prs["Pull Requests<br/>(via title/branch<br/>containing key)"]
    notes["Notes<br/>(local, per ticket)"]
    steps["Next Steps<br/>(AI-drafted)"]
    sdlc["SDLC Events<br/>(smoketests, deploys)"]
    diagrams["Diagrams<br/>(from agent runs)"]

    ticket --- runs
    ticket --- prs
    ticket --- notes
    ticket --- steps
    ticket --- sdlc
    ticket --- diagrams
```

## SDLC Progress Tracking

```mermaid
flowchart LR
    s1["1. Ideation<br/>✓ always"]
    s2["2. PR Exists<br/>GitHub"]
    s3["3. Local Plan<br/>SQLite"]
    s4["4. Local Test<br/>SQLite"]
    s5["5. Review Req<br/>SQLite"]
    s6["6. In Beta<br/>SQLite"]
    s7["7. Beta Plan<br/>SQLite"]
    s8["8. Beta Test<br/>SQLite"]
    s9["9. In Prod<br/>SQLite"]
    s10["10. Prod Plan<br/>SQLite"]
    s11["11. Prod Test<br/>SQLite"]
    s12["12. Done<br/>Jira"]

    s1 --> s2 --> s3 --> s4 --> s5 --> s6 --> s7 --> s8 --> s9 --> s10 --> s11 --> s12
```

## SQLite Storage Schema

```mermaid
erDiagram
    summaries ||--o{ next_steps : contains
    summaries {
        string ticket PK
        string status
        datetime requested_at
        datetime generated_at
        text summary
        text error
    }
    next_steps {
        int summary_id FK
        string ticket
        int position
        text body
    }
    notes {
        int id PK
        string ticket
        datetime created_at
        text body
    }
    tickets {
        string key PK
        datetime snoozed_until
        datetime starred_at
    }
    diagrams {
        string key PK
        string session_id
        string ticket
        string kind
        string title
        text source
        datetime created_at
    }
    SDLC_Event ||--o{ SDLC_Event_Ticket : has
    SDLC_Event ||--o{ SDLC_Event_Environment : has
    SDLC_Event {
        int id PK
        string event_type
        datetime started_at
        datetime finished_at
        string outcome
        text test_details
        text test_results
    }
    conversation_summaries {
        string session_id PK
        string status
        text about
        text latest
        text needs
        datetime generated_at
    }
```

## API Routes

```mermaid
flowchart LR
    subgraph read["Read Operations"]
        dash["GET /api/dashboard"]
        hist["GET /api/history"]
        trans["GET /api/transcript"]
        pr["GET /api/pr"]
        ticket["GET /api/ticket"]
    end

    subgraph write["Write Operations"]
        reply["POST /api/reply"]
        stop["POST /api/stop"]
        agents["POST /api/agents"]
        conv["POST /api/conversations"]
        sdlc["POST /api/sdlc-events"]
        snooze["POST /api/snooze"]
        star["POST /api/star"]
    end

    subgraph sse["Real-time"]
        events["GET /api/events<br/>(Server-Sent Events)"]
    end
```

## Key Workflows

### Starting a New Agent

```mermaid
sequenceDiagram
    participant User
    participant Web as Web UI
    participant Server
    participant Handoff as Handoff Generator
    participant Pi as Pi Agent

    User->>Web: Click "Start a new agent"
    User->>Web: Type message, pick folder
    Web->>Server: POST /api/agents?ticket=KEY
    Server->>Handoff: Build context file
    Note over Handoff: Includes: notes, next steps,<br/>PR summaries, agent history
    Handoff->>Server: context.md
    Server->>Pi: pi --mode rpc --name "KEY: ..."
    Pi->>Server: Session started
    Server->>Web: {sessionId}
    Web->>Web: Navigate to #/c:sessionId
```

### Live Agent Control

```mermaid
sequenceDiagram
    participant User
    participant Web as Web UI
    participant Server
    participant Inbox as Inbox Folder
    participant Ext as Extension
    participant Pi as Pi Agent

    Note over Pi: Agent is working...
    
    User->>Web: Type reply + "Steer now"
    Web->>Server: POST /api/reply {text, steer: true}
    Server->>Inbox: Write <n>.steer
    Ext->>Inbox: Watch detects file
    Ext->>Pi: sendUserMessage(text, deliverAs: "steer")
    Note over Pi: Agent reads message<br/>before next model call

    User->>Web: Click "Stop"
    Web->>Server: POST /api/stop
    Server->>Inbox: Write <n>.abort
    Ext->>Inbox: Watch detects file
    Ext->>Pi: ctx.abort()
    Note over Pi: Agent stops
```

## Summary

Agent-dash provides:

1. **Unified View**: Aggregates pi sessions, Jira tickets, GitHub PRs, and Slack into one dashboard
2. **Smart Prioritization**: Scores and ranks everything by urgency so you know what to look at next
3. **Live Control**: Send replies, steer, and stop agents without switching to iTerm
4. **SDLC Tracking**: Tracks progress from ideation through production deployment
5. **AI Summaries**: Auto-generated summaries of agent conversations and next steps
6. **Diagram Collection**: Captures and displays charts/diagrams agents create

All data stays local (SQLite + file system), with external APIs called only for Jira/GitHub/Slack data.
