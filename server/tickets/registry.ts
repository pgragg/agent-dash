import type { Ticket } from "../../shared/types.ts";
import { config, type TicketProviderConfig } from "../config.ts";
import { JiraProvider } from "./jira.ts";
import { LocalFilesProvider } from "./localFiles.ts";
import type { TicketProvider } from "./provider.ts";

const prefixOf = (key: string) => key.slice(0, key.lastIndexOf("-"));

/** The configured ticket providers, in order, and which one owns a key. */
export class TicketProviders {
  readonly list: TicketProvider[];

  constructor(list: TicketProvider[]) {
    this.list = list;
  }

  /** The provider that names the key's prefix, else the first one that takes any key. */
  providerFor(key: string): TicketProvider | undefined {
    const prefix = prefixOf(key);
    return this.list.find((p) => p.prefixes?.includes(prefix)) ?? this.list.find((p) => p.prefixes === null);
  }

  /** The ticket's link, or null when no provider owns the key. */
  ticketUrl = (key: string): string | null => this.providerFor(key)?.ticketUrl(key) ?? null;

  /** A ticket that a run or PR names, but that its provider did not return. */
  stub = (key: string): Ticket => {
    const p = this.providerFor(key);
    const source = p?.source ?? { id: "none", label: "no tracker", dueDate: false, move: false };
    return { key, url: p?.ticketUrl(key) ?? "", summary: `(not found in ${source.label})`, status: "?", statusCategory: "new", priority: null, dueDate: null, updatedAt: "", assignedToMe: false, source };
  };
}

/** One provider per config entry. */
export function createProviders(configs: TicketProviderConfig[], o: { port: number; ttlMs: number }): TicketProviders {
  return new TicketProviders(configs.map((c) => (c.type === "jira" ? new JiraProvider(c, o.ttlMs) : new LocalFilesProvider(c, o.port))));
}

/** The server's providers, from its config. */
export const ticketProviders = createProviders(config.ticketProviders, { port: config.port, ttlMs: config.remoteTtlMs });
