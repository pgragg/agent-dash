import { prRef } from "../../shared/refs.ts";
import { href } from "./routes.ts";

/** A Jira browse link on any host, because JIRA_SERVER can point anywhere. */
export const JIRA_BROWSE = /\/browse\/([A-Z][A-Z0-9]*-\d+)(?=[/?#]|$)/;

/**
 * The agent-dash address for a link in an agent message, or null to keep it external.
 * A Jira key opens in the dash only when the board has the ticket; otherwise the page would be empty.
 */
export function internalHref(url: string, knownTickets: ReadonlySet<string>): string | null {
  if (!/^https?:\/\//.test(url)) return null;
  const pr = /^https?:\/\/github\.com\//.test(url) ? prRef(url) : null;
  if (pr) return href(pr);
  const key = url.match(JIRA_BROWSE)?.[1];
  return key && knownTickets.has(key) ? href(`t:${key}`) : null;
}

type Click = Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/**
 * Where a click on a link with an agent-dash address goes. The link's href stays the GitHub or Jira URL, so a copy
 * or "Copy link address" carries a URL that works for other people. Null leaves the click to the browser.
 */
export function dashClick(e: Click): "here" | "tab" | null {
  if (e.altKey) return null;
  if (e.button === 1) return "tab";
  if (e.button !== 0) return null;
  return e.metaKey || e.ctrlKey || e.shiftKey ? "tab" : "here";
}

/** "see https://x.y/a." links "https://x.y/a": a sentence's full stop is not part of the URL. */
export function splitTrailing(token: string): { url: string; trailing: string } {
  const url = token.replace(/[.,;:!?'"]+$/, "");
  return { url, trailing: token.slice(url.length) };
}
