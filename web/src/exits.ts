import { classifyHref, type Exit, type ExitKind, sectionOf } from "../../shared/exits.ts";
import { parseHash } from "./routes.ts";

/**
 * Counts every link out of the dash, from one capturing listener, so no component needs a hook.
 * "Open in iTerm" is counted on the server instead, because the `O` key reaches it without a click.
 */

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;

function classChain(el: Element): string[] {
  const out: string[] = [];
  for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
    if (typeof e.className === "string" && e.className) out.push(e.className);
  }
  return out;
}

const KEY_IN_HREF = /(?:\/browse\/|^#\/t:)([A-Z][A-Z0-9]+-\d+)/;

/** The ticket of the page area clicked: the selected ticket, its box's key link, else the link's own key. */
function ticketFor(el: Element, fromHref: string | null): string | null {
  const ref = decodeURIComponent(location.hash.match(/^#\/t:([^/]+)$/)?.[1] ?? "");
  if (KEY.test(ref)) return ref;
  // A workspace, a PR group, or an action row shows its own ticket as a key link.
  for (const box of [el.closest(".stack, .action"), el.closest("article")]) {
    for (const a of box?.querySelectorAll("a.key-link") ?? []) {
      const key = a.getAttribute("href")?.match(KEY_IN_HREF)?.[1];
      if (key) return key;
    }
  }
  return fromHref;
}

function send(exit: Exit): void {
  // keepalive lets the request finish even if the click unloads the page.
  fetch("/api/exits", { method: "POST", keepalive: true, headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: JSON.stringify(exit) }).catch(() => {});
}

function record(el: Element, kind: ExitKind, host: string | null, ticket: string | null): void {
  send({ kind, host, view: parseHash(location.hash).view, section: sectionOf(classChain(el)), ticket: ticketFor(el, ticket) });
}

function onClick(e: MouseEvent): void {
  // auxclick also fires for the right button, which opens a menu, not the link.
  if (e.type === "auxclick" && e.button !== 1) return;
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (link && (link.target === "_blank" || e.button === 1 || e.metaKey || e.ctrlKey) && /^https?:/.test(link.href) && link.origin !== location.origin) {
    const { kind, host, ticket } = classifyHref(link.href);
    return record(link, kind, host, ticket);
  }
  if (e.type !== "click") return;
  const button = target.closest("button");
  if (button && (button.dataset.exit === "copy_resume" || button.textContent?.trim() === "Copy resume")) record(button, "copy_resume", "terminal", null);
}

document.addEventListener("click", onClick, true);
document.addEventListener("auxclick", onClick, true);
