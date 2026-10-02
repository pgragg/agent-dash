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
  sessionId?: string;
  prUrl?: string;
  since: string;
  /** The run to jump to from this row: the run itself, the run that opened the PR, or the ticket's latest run. */
  run?: Run;
}

export interface TicketGroup {
  ticket: Ticket;
  /** Oldest first. */
  runs: Run[];
  prs: PullRequest[];
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
  sources: { jira: SourceHealth; github: SourceHealth; sessions: SourceHealth };
  extensionInstalled: boolean;
}
