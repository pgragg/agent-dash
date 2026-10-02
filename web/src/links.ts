import { prRef } from "../../shared/refs.ts";
import { href } from "./routes.ts";

const JIRA = /atlassian\.net\/browse\/([A-Z][A-Z0-9]*-\d+)/;

/**
 * The agent-dash address for a link in an agent message, or null to keep it external.
 * A Jira key opens in the dash only when the board has the ticket; otherwise the page would be empty.
 */
export function internalHref(url: string, knownTickets: ReadonlySet<string>): string | null {
  if (!/^https?:\/\//.test(url)) return null;
  const pr = /^https?:\/\/github\.com\//.test(url) ? prRef(url) : null;
  if (pr) return href(pr);
  const key = url.match(JIRA)?.[1];
  return key && knownTickets.has(key) ? href(`t:${key}`) : null;
}
