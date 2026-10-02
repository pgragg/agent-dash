/** Data contract between the server and the web page. */

export type RunStatus = "working" | "awaiting_input" | "finished";

/** Where the run status came from. "extension" is exact; "heuristic" is a guess from the log. */
export type StatusSource = "extension" | "heuristic";

export interface Run {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  name: string | null;
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
  /** Ticket keys, strongest link first. */
  tickets: string[];
  /** PRs that this run opened with `gh pr create`. */
  createdPrs: string[];
  /** Every PR URL that this run named. Used to link a run to a ticket through its PR. */
  mentionedPrs: string[];
  userMessageCount: number;
  /** The iTerm2 tab that runs this session. Set only while the session is live. */
  itermSessionId: string | null;
  /** The live session runs a status extension with a reply inbox, so the dash can send it a message. */
  canReply: boolean;
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
  updatedAt: string;
  tickets: string[];
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
}

export type AttentionKind =
  | "awaiting_input"
  | "run_error"
  | "changes_requested"
  | "ci_failing"
  | "merge_conflict"
  | "ready_to_merge"
  | "overdue"
  | "due_soon"
  | "stalled";

export interface AttentionItem {
  kind: AttentionKind;
  score: number;
  /** One line that says why this item is on the list. */
  reason: string;
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
}

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

export type ThreadStatus = "relevant" | "resolved";

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

export interface TicketGroup {
  ticket: Ticket;
  /** Oldest first. Resolved threads stay here; `threads` says which ones they are. */
  runs: Run[];
  prs: PullRequest[];
  /** The newest status change per session, for this ticket's threads that have one. No entry means relevant. */
  threads: Record<string, ThreadStatusChange>;
}

export interface SourceHealth {
  ok: boolean;
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
  counts: Record<RunStatus, number>;
  /** Next-steps summaries by ticket key. */
  summaries: Record<string, TicketSummaryState>;
  /** Private notes by ticket key, oldest first. */
  notes: Record<string, Note[]>;
  sources: { jira: SourceHealth; github: SourceHealth; sessions: SourceHealth };
  extensionInstalled: boolean;
}
