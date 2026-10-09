import type { AgentKind, Team } from "./team.ts";
/** Data contract between the server and the web page. */

export type RunStatus = "working" | "awaiting_input" | "finished";

/** Where the run status came from. "extension" is exact; "heuristic" is a guess from the log. */
export type StatusSource = "extension" | "heuristic";

export interface Run {
  /** The agent that runs it. */
  agent: AgentKind;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  name: string | null;
  /** A short title that agent-dash drafted for a run with no name. Null until it is drafted. */
  title: string | null;
  firstPrompt: string;
  /** Last non-empty line of the latest assistant reply. */
  lastReply: string;
  /** The whole latest reply (markdown), cut from the start when very long. */
  lastMessage: string;
  startedAt: string;
  lastActivityAt: string;
  model: string | null;
  status: RunStatus;
  statusSource: StatusSource;
  /** When the run entered its current status. */
  statusSince: string;
  /** The latest reply ends in a question to the user. */
  askedQuestion: boolean;
  /** The latest assistant message ended in an API error. */
  endedInError: boolean;
  /** You pressed Esc on the latest reply. */
  stoppedByUser: boolean;
  /** Ticket keys, strongest link first. */
  tickets: string[];
  /** Tickets that the run only names in its prompts or replies. They give no signal until you link them. */
  suggestedTickets: string[];
  /** PRs that this run opened with `gh pr create`. */
  createdPrs: string[];
  /** Every PR URL that this run named. Used to link a run to a ticket through its PR. */
  mentionedPrs: string[];
  userMessageCount: number;
  /** The iTerm2 tab that runs this session. Set only while the session is live. */
  itermSessionId: string | null;
  /** The live session runs a status extension with a reply inbox, so the dash can send it a message. */
  canReply: boolean;
  /** A live headless conversation: no terminal, so the dash page is where you talk to it. */
  headless: boolean;
  /** The tool that runs now. Only while working, and only from an extension of version 2 or later. */
  activity?: RunActivity | null;
  /** An extension dialog waits for an answer. The page can answer it only in a headless run. */
  dialog?: RunDialog | null;
  /** The live session's extension takes Stop and Steer. Without it, the page asks for /reload. */
  canControl?: boolean;
  /** It takes Steer too. Claude Code takes Stop only. */
  canSteer?: boolean;
}

/** One tool call in progress, as the status extension reports it. */
export interface RunActivity {
  tool: string;
  /** A short, one-line summary of the arguments: the command for bash, the path for read. */
  summary: string;
  since: string;
}

/** An open `ctx.ui` dialog in a live session. */
export interface RunDialog {
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** The prefill was too long for the status file: sending the page's copy back would lose text. */
  prefillCut?: boolean;
  since: string;
}

/** Why agent-dash parked a waiting agent. */
export type ParkReason = "ticket_done" | "resolved" | "needs_nothing" | "superseded" | "stale" | "over_cap";

/**
 * A waiting headless agent that agent-dash stopped. Its session log stays, so Resume continues it;
 * the row keeps what the agent needed, because a stopped run gets no new summary.
 */
export interface ParkedRun {
  sessionId: string;
  ticket: string | null;
  name: string | null;
  cwd: string;
  reason: ParkReason;
  parkedAt: string;
  /** What the agent needed from Piper when it was parked, from its summary. */
  needs: string | null;
  /** What its last message said, from its summary. */
  latest: string | null;
  /** The end of its last message, for when the summary is missing. */
  lastMessage: string;
}

/** A run in the History view. The whole last message stays out, so the list of every chat stays small. */
export type HistoryRun = Omit<Run, "lastMessage">;

/** One prompt or reply of a chat. Tool calls and their output are left out. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
  at: string | null;
}

export interface Transcript {
  sessionId: string;
  turns: Turn[];
}

export type CheckState = "success" | "failure" | "pending" | "none";

export interface PullRequest {
  url: string;
  repo: string;
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  headRef: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: CheckState;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** GitHub's own verdict: "CLEAN" means every branch rule passes, so the PR can merge now. */
  mergeStateStatus?: string;
  updatedAt: string;
  tickets: string[];
  /** Names of the failing checks and status contexts on the head commit. */
  failedChecks?: string[];
  /** On an open PR: the feedback entries with no answer yet, by the PR panel's rule. */
  toAddress?: number;
  /** On an open PR: the people whose latest review approves it. */
  approvals?: number;
}

/** One check run or status context on a PR's head commit. */
export interface PrCheck {
  name: string;
  /** "success", "failure", "pending", "skipped", "neutral"... lower case. */
  state: string;
  url: string | null;
  /** For a failed GitHub Actions job: the end of its log, up to the last error. */
  logTail?: string;
}

export interface PrReviewComment {
  author: string;
  /** A GitHub App, or a login that ends in "bot". */
  bot: boolean;
  body: string;
  createdAt: string;
  url: string;
}

export interface PrReviewThread {
  path: string;
  line: number | null;
  isOutdated: boolean;
  comments: PrReviewComment[];
}

/** A submitted review. GitHub also makes one, with no body, for each batch of thread comments. */
export interface PrReview {
  author: string;
  bot: boolean;
  state: string;
  body: string;
  submittedAt: string;
  url: string;
}

/** A comment on the PR's conversation tab, not on a line. */
export interface PrConversationComment {
  author: string;
  bot: boolean;
  body: string;
  createdAt: string;
  url: string;
}

/** One PR in full, for the PR panel. Fetched on demand from GET /api/pr, never part of the dashboard. */
export interface PrDetail {
  url: string;
  repo: string;
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  author: string | null;
  body: string;
  baseRef: string;
  headRef: string;
  reviewDecision: PullRequest["reviewDecision"];
  mergeable: PullRequest["mergeable"];
  checks: CheckState;
  checkRuns: PrCheck[];
  /** Only threads that are not resolved. */
  threads: PrReviewThread[];
  reviewers: { login: string; state: string }[];
  /** The last 50 reviews and conversation comments, oldest first. */
  reviews: PrReview[];
  comments: PrConversationComment[];
  /** When the head commit was made. */
  lastCommitAt: string | null;
  /** Feedback keys that Piper marked addressed on the panel. Saved in SQLite, never on GitHub. */
  addressed: string[];
  requestedReviewers: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { path: string; additions: number; deletions: number }[];
  updatedAt: string;
  /** Ticket keys in the title or branch. */
  tickets: string[];
  fetchedAt: string;
}

export interface Ticket {
  key: string;
  url: string;
  summary: string;
  status: string;
  statusCategory: "new" | "indeterminate" | "done";
  priority: string | null;
  dueDate: string | null;
  updatedAt: string;
  assignedToMe: boolean;
  /** Set when a file is the ticket, as with a local ticket: the page links to it, and agents read it. */
  file?: string;
  /** The tracker that holds the ticket, and the changes that the dash can make there. */
  source: TicketSource;
}

/** A ticket provider (`server/tickets/`), as a ticket and the page see it. */
export interface TicketSource {
  /** The provider's id, such as "jira" or "local-AD". It is also its key in `Dashboard.sources`. */
  id: string;
  /** The tracker's name for people: "Open in Jira", "Done in Jira". */
  label: string;
  /** The dash can set the due date. */
  dueDate: boolean;
  /** The dash can move the ticket to another status. */
  move: boolean;
}

export type AttentionKind =
  | "awaiting_input"
  | "run_error"
  | "changes_requested"
  | "ci_failing"
  | "merge_conflict"
  | "ready_to_merge"
  /** Approved and green, but a review comment or thread still needs an answer. */
  | "approved_with_feedback"
  | "in_review"
  | "overdue"
  | "due_soon"
  | "stalled";

export interface AttentionItem {
  kind: AttentionKind;
  score: number;
  /** One line that says why this item is on the list. */
  reason: string;
  /** The object's own name, in full: the run's session name, "repo#n" for a PR, or the ticket key. */
  name: string;
  /** A PR row's PR title. */
  title?: string;
  /** The state in a few words, for the row's status chip: "waiting 13h", "CI red", "3d late". */
  status: string;
  /** Context, not a call to act: the ball is with someone else. Alone, it does not put an entry in the queue. */
  info?: boolean;
  ticketKey: string | null;
  ticketUrl: string | null;
  sessionId?: string;
  prUrl?: string;
  since: string;
  /** When the thing behind the row last changed: the run's log, the PR, or the Jira ticket. */
  updatedAt: string;
  /** The run to jump to from this row: the run itself, the run that opened the PR, or the ticket's latest run. */
  run?: Run;
}

export interface TicketSummary {
  id: number;
  ticket: string;
  status: "in_progress" | "done" | "failed";
  requestedAt: string;
  generatedAt: string | null;
  summary: string | null;
  error: string | null;
  /** The summary's numbered next steps, in order. Empty until it is done. */
  steps: NextStep[];
}

/** One step of a drafted next-steps summary. The page can start an agent on it. */
export interface NextStep {
  id: number;
  summaryId: number;
  ticket: string;
  /** 1-based order in the summary. */
  position: number;
  body: string;
  /** A short button label for the kanban card, from the cheap model. Null until it is drafted. */
  label: string | null;
  /** What the kanban card's button does on a click. The label was written from it. Null until it is read. */
  action: StepAction | null;
}

/** The kanban card button's click: a Jira move, else an agent that starts with this first message. */
export type StepAction = { kind: "move"; to: string } | { kind: "agent"; message: string };

/** The newest request (any status), and the newest finished summary to show meanwhile. */
export interface TicketSummaryState {
  latest: TicketSummary;
  lastDone: TicketSummary | null;
}

/** A private note you wrote on a ticket. Summary runs read these. */
export interface Note {
  id: number;
  ticket: string;
  createdAt: string;
  body: string;
}

/** "unlinked" takes the thread off the ticket, as if it never named it. */
export type ThreadStatus = "relevant" | "resolved" | "unlinked";

/** One change to whether a pi thread still matters to a ticket. The newest change is the current state. */
export interface ThreadStatusChange {
  id: number;
  ticket: string;
  sessionId: string;
  status: ThreadStatus;
  /** Why it was resolved. Optional, and only for "resolved". */
  reason: string | null;
  createdAt: string;
}

export type DiagramKind = "mermaid" | "svg" | "png" | "jpeg" | "gif" | "webp";

/** A stored copy, so a diagram opens after its conversation, file, or ticket is gone. */
export interface Diagram {
  id: number;
  kind: DiagramKind;
  title: string;
  /** The conversation that made it. */
  sessionId: string;
  /** The conversation's main ticket. Null when the conversation has no ticket. */
  ticket: string | null;
  /** "reply" for a fence in a reply, else the file path as written. */
  origin: string;
  /** SHA-1 of the source, so a fence on the page can find its diagram. */
  hash: string;
  /** When the agent wrote it. */
  createdAt: string;
  /** When you last changed its title or source. */
  editedAt: string | null;
}

/** `ticket-summary`: the start, middle and end states of a ticket. A ticket has at most one. */
export type DocumentType = "document" | "ticket-summary";

/** A markdown document on a ticket, without its body. Its images are rows of their own, so the body stays small. */
export interface TicketDocument {
  id: number;
  ticket: string | null;
  type: DocumentType;
  title: string;
  /** The conversation that made it, if one did. */
  sessionId: string | null;
  /** The diagram that it was made from, by the migration. */
  diagramId: number | null;
  createdAt: string;
  updatedAt: string;
  /** False while an agent writes the first version. */
  hasBody: boolean;
  /** An agent edit that has not saved yet: your prompt, its agent, and when it started. */
  edit: { prompt: string; sessionId: string; startedAt: string } | null;
}

export interface TicketDocumentWithBody extends TicketDocument {
  /** Markdown. An embedded image is `![alt](image:N)`, served by `/api/document/image?id=N`. */
  body: string;
}

export interface TicketGroup {
  ticket: Ticket;
  /** Oldest first. Resolved threads stay here; `threads` says which ones they are. */
  runs: Run[];
  /** Runs that only mention the ticket: suggested links, oldest first. They give no queue signal. */
  suggested?: Run[];
  prs: PullRequest[];
  /** The newest status change per session, for this ticket's threads that have one. No entry means relevant. */
  threads: Record<string, ThreadStatusChange>;
}

/** An environment under test. A tag names what the event tested, not every system it touched. */
export type SdlcEnvironment = "localhost" | "fern_dev" | "fern_prod" | "postman_beta" | "postman_prod";

/**
 * A smoketest has two phases: an agent writes a plan ("smoketest_plan"), then runs it ("smoketest_execution").
 * "deploy" is a deploy that Argo or Piper confirmed: the In Beta and In Prod stages. "review_request": a Slack message that asked for a PR review.
 */
export type SdlcEventType = "smoketest_plan" | "smoketest_execution" | "deploy" | "review_request";

export type SmoketestOutcome = "passed" | "failed" | "blocked";
/** "unhealthy" is for a deploy only: the change runs in the environment, but it does not give its benefit yet. */
export type SdlcOutcome = SmoketestOutcome | "unhealthy";

/** One thing that happened to a ticket's change on its way to prod. One `SDLC_Event` row. */
export interface SdlcEvent {
  id: number;
  eventType: SdlcEventType;
  startedAt: string;
  finishedAt: string | null;
  /** No outcome counts as passed, except on a dash-started smoketest: that one is still running. "blocked": the test could not run or could not see the result. "unhealthy": see SdlcOutcome. */
  outcome: SdlcOutcome | null;
  /** On a plan: the plan itself. */
  testDetails: string | null;
  testResults: string | null;
  /** The pi session that runs it, when agent-dash started that session. */
  sessionId: string | null;
  /** Set on a smoketest that Piper chose to skip. It has no outcome. */
  skippedAt: string | null;
  /** On a plan: when the agent last recorded it. Null while the agent still writes it. */
  plannedAt: string | null;
  /** On a plan: the Beta or Prod writes that the test needs, one per line. Null: it changes no Beta or Prod state. */
  stateChanges: string | null;
  /** On a plan: a short summary of its Beta or Prod writes, by environment. Null: none, or a plan from before this field. */
  writesSummary: string | null;
  /** On a plan: when it was accepted, and by whom. "auto": it changes no Beta or Prod state. */
  confirmedAt: string | null;
  /** The GitHub login of the person who confirmed the plan, or "auto" for a plan with no state changes. */
  confirmedBy: string | null;
  /** On an execution: the plan that it runs. */
  planId: number | null;
  /** One short line from the agent that ran the smoketest: what it showed. The collapsed row shows it. On a plan: a very short summary of the plan. */
  summary: string | null;
  /** A review request's PR, Slack channel id, message text and message permalink. Null on other events. */
  prUrl: string | null;
  channel: string | null;
  message: string | null;
  messageUrl: string | null;
  /** Empty on a review request. */
  environments: SdlcEnvironment[];
  /** Can be empty on a review request for a PR with no ticket. */
  tickets: string[];
  createdAt: string;
}

/** A drafted Slack review request for one open PR, from a cheap model. One `review_drafts` row. */
export interface ReviewDraft {
  prUrl: string;
  status: "in_progress" | "done" | "failed";
  /** The whole message: "PR: <what it does> <url>". */
  text: string | null;
  error: string | null;
  requestedAt: string;
}

/** The short summary on an agent conversation, from a cheap model. */
export interface ConversationSummary {
  sessionId: string;
  status: "in_progress" | "done" | "failed";
  /** What the conversation is about. Null until the first draft is done. */
  about: string | null;
  /** What the agent's latest message says. */
  latest: string | null;
  /** What the agent needs from Piper, or "Nothing". */
  needs: string | null;
  generatedAt: string | null;
  error: string | null;
  /** The texts are from an older state of the run: a newer message came after them. */
  stale: boolean;
}

export interface SourceHealth {
  ok: boolean;
  /** The source's name for people, such as "Jira" or "AD tickets". */
  label?: string;
  /** Not set up, so never asked: not a failure. */
  off?: boolean;
  error?: string;
  fetchedAt?: string;
}

export interface Dashboard {
  generatedAt: string;
  attention: AttentionItem[];
  /** Tickets assigned to me that are not Done. */
  myTickets: TicketGroup[];
  /** Tickets not assigned to me (or Done) that had a run in the recent window. */
  otherTickets: TicketGroup[];
  /** Recent runs that link to no ticket. Newest first. */
  unlinkedRuns: Run[];
  /** All my PRs in the window, with the tickets that cross-linking gave them. */
  prs: PullRequest[];
  counts: Record<RunStatus, number>;
  /** Next-steps summaries by ticket key. */
  summaries: Record<string, TicketSummaryState>;
  /** Private notes by ticket key, oldest first. */
  notes: Record<string, Note[]>;
  /** When each snoozed ticket comes back to the board, by ticket key. It can be in the past. */
  snoozedUntil: Record<string, string>;
  /** Starred ticket keys, first starred first. They go to the top of the board and the PRs view. */
  starred: string[];
  /** Every picture an agent showed in a message, newest first, without its source: a message finds its document from here. */
  diagrams: Diagram[];
  /** Every document, without its body. A ticket's ticket summary first, then the newest change first. */
  documents: TicketDocument[];
  /** SDLC events (smoketests, confirmed deploys) by ticket key, newest first. */
  sdlcEvents: Record<string, SdlcEvent[]>;
  /** Drafted Slack review requests by PR URL. */
  reviewDrafts: Record<string, ReviewDraft>;
  /** The short summary of each run on the board, by session id. */
  conversationSummaries: Record<string, ConversationSummary>;
  /** Review requests sent from agent-dash by PR URL, newest first. Also for PRs with no ticket. */
  reviewRequests: Record<string, SdlcEvent[]>;
  /** Parallel lanes by ticket key, oldest first, without removed ones. */
  lanes: Record<string, WorkLane[]>;
  /** Waiting agents that agent-dash stopped to keep the waiting list short, newest first. */
  parked: ParkedRun[];
  /** One health per ticket provider, by its id, next to GitHub and the session logs. */
  sources: Record<string, SourceHealth> & { github: SourceHealth; sessions: SourceHealth };
  extensionInstalled: boolean;
  /** Settings that a new user still has to set, in words. Empty when the board can work. */
  setup?: string[];
  /** The team settings that shared code reads; the page sets them from here. */
  team?: Team;
}

/** One comment on a ticket, with its body as markdown. */
export interface TicketComment {
  author: string;
  created: string;
  body: string;
}

/** A status the ticket can move to now, from the tracker's transitions list. */
export interface TicketTransition {
  id: string;
  /** The transition's own name, such as "Ready for Review". */
  name: string;
  /** The status it leads to, such as "In Review". */
  to: string;
}

/** `GET /api/ticket?key=KEY`: read lazily, so the dashboard payload stays small. */
export interface TicketDetail {
  key: string;
  status: string;
  dueDate: string | null;
  /** Markdown. */
  description: string;
  /** The newest comments, oldest first. */
  comments: TicketComment[];
  commentTotal: number;
  transitions: TicketTransition[];
  /** Set when the transitions could not be read; the rest is still good. */
  transitionsError?: string;
  fetchedAt: string;
}

/** A Slack message that a next-steps summary links to, as the summary run found it. */
export interface SlackQuote {
  permalink: string;
  channel: string;
  user: string;
  ts: string;
  text: string;
}

/**
 * How a lane's work comes back. "land": into the ticket's integration branch, one lane at a time,
 * and one PR from there. "pr": each lane opens its own PR into the base.
 */
export type LaneMode = "land" | "pr";

/** "landing" while its land runs; "conflict" and "checks_failed" after a land that did not go in. */
export type LaneState = "working" | "landing" | "landed" | "conflict" | "checks_failed" | "removed";

/** One of N agents on a ticket, each in its own git worktree. The server makes the worktree and this record. */
export interface WorkLane {
  id: number;
  ticket: string;
  /** The repo's main checkout, which holds the `.git` folder. */
  repo: string;
  lane: string;
  mode: LaneMode;
  /** The branch on origin that the work goes into, for example `main`. */
  base: string;
  branch: string;
  worktree: string;
  /** In "land" mode, the ticket's branch and worktree that the lanes land into. */
  integrationBranch: string | null;
  integrationWorktree: string | null;
  sessionId: string | null;
  goal: string;
  state: LaneState;
  /** What the last land said: the conflicting files, or why it was refused. */
  note: string | null;
  createdAt: string;
  landedAt: string | null;
  /** Read from the worktree on each build. Null when the worktree is gone. */
  git: LaneGit | null;
  /** In "land" mode, commits on the integration branch that `origin/<base>` does not have. */
  integrationAhead: number | null;
}

export interface LaneGit {
  /** The branch checked out now. It differs from the lane's branch when the agent switched. */
  head: string | null;
  /** Commits on the lane that its base does not have, and the reverse. */
  ahead: number;
  behind: number;
  /** Changed and new files that are not committed. */
  dirty: number;
}

/** A git worktree of a repo that agent-dash knows, for the Worktrees view and its Clean up. */
export interface WorktreeInfo {
  /** The repo's main checkout. */
  repo: string;
  path: string;
  /** Null on a detached HEAD. */
  branch: string | null;
  /** The lane or integration branch that owns it, or null for an orphan. */
  owner: { ticket: string; laneId: number | null; lane: string | null } | null;
  /** Origin's default branch, which "behind" and "contained" count against. */
  base: string;
  ahead: number;
  behind: number;
  /** Every commit of the branch (or the detached HEAD) is on `origin/<base>`. */
  contained: boolean;
  dirty: number;
  pr: { url: string; state: string } | null;
  /** When git last moved its HEAD: a commit, a checkout, a reset, or the worktree's creation. */
  lastUsedAt: string | null;
  /** A live pi session that started in this folder. */
  liveSession: string | null;
  /** Why Clean up is off, or null. */
  blocker: string | null;
  /** Clean up also deletes the branch, because its work is on the base or its PR merged. */
  deletesBranch: boolean;
}
