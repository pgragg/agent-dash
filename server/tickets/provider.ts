import type { Ticket, TicketDetail, TicketSource } from "../../shared/types.ts";

/** What changed on a ticket, so the board shows it before the provider is asked again. */
export type OnTicketChange = (key: string, patch: Partial<Pick<Ticket, "status" | "statusCategory" | "dueDate">>) => void;

/** The answer to a change that the page asked for: an HTTP status and a JSON body. */
export interface VerbResult {
  status: number;
  body: unknown;
}

/**
 * One ticket tracker, such as a Jira site or a folder of markdown files. The board reads every
 * configured provider through this interface, so no tracker is a special case.
 */
export interface TicketProvider {
  /** Its id, name, and the changes it supports, as each of its tickets carries them. */
  readonly source: TicketSource;
  /** Key prefixes that it owns, such as ["AD"], or null for every key that no other provider claims. */
  readonly prefixes: string[] | null;
  /** Set up enough to ask. A provider that is off is never asked, and is not shown as down. */
  readonly enabled: boolean;
  /**
   * Cheap and complete: `lookup` reads everything the provider has. The board asks it on every
   * build with no cache, and a key that it does not find is not a ticket.
   */
  readonly exhaustive: boolean;

  /** Open tickets assigned to me. */
  listMine(): Promise<Ticket[]>;
  /** The tickets with these keys, open or not. A key that it does not know is left out. */
  lookup(keys: string[]): Promise<Ticket[]>;
  /** The ticket's text, comments and transitions, read when its section opens. Null: no such ticket. */
  detail(key: string, refresh: boolean): Promise<TicketDetail | null>;
  /** The ticket's link, also for a key that the provider could not find. */
  ticketUrl(key: string): string;
  /** Step 2 of a next-steps summary agent's prompt: how the agent reads the ticket. */
  agentReadStep(key: string): string;

  /** Set the due date, if it is still `from`: the click approved a change from that date only. */
  setDueDate?(key: string, date: string, from: string | null, onChange: OnTicketChange): Promise<VerbResult>;
  /** Move the ticket to status `to`, if it is still at `from`. */
  move?(key: string, to: string, from: string, onChange: OnTicketChange): Promise<VerbResult>;
  /** The ticket as plain text, for a tracker with no web page of its own. Null: no such ticket. */
  rawText?(key: string): string | null;
}
