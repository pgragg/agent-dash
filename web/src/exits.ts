import { classifyHref, type Exit, type ExitKind, pickTicket, sectionOf } from "../../shared/exits.ts";
import { parseHash } from "./routes.ts";

/**
 * Counts every link out of the dash, from one capturing listener, so no component needs a hook.
 * "Open in iTerm" is counted on the server instead, because the `O` key reaches it without a click.
 */

function classChain(el: Element): string[] {
  const out: string[] = [];
  for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
    if (typeof e.className === "string" && e.className) out.push(e.className);
  }
  return out;
}

function keyLinks(box: Element | null): string[] {
  return [...(box?.querySelectorAll("a.key-link") ?? [])].map((a) => a.getAttribute("href") ?? "");
}

function send(exit: Exit): void {
  // keepalive lets the request finish even if the click unloads the page.
  fetch("/api/exits", { method: "POST", keepalive: true, headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: JSON.stringify(exit) }).catch(() => {});
}

function record(el: Element, kind: ExitKind, host: string | null, ticket: string | null): void {
  // A lost count must never break the click, so nothing here may throw.
  try {
    // Only a PR group or an action row has a ticket of its own; board stacks use the workspace's.
    const box = el.closest(".action, .stack:has(> .pr-group-head)");
    const t = pickTicket(location.hash, box && keyLinks(box), keyLinks(el.closest("article")), ticket);
    send({ kind, host, view: parseHash(location.hash).view, section: sectionOf(classChain(el)), ticket: t });
  } catch {}
}

function onClick(e: MouseEvent): void {
  // auxclick also fires for the right button, which opens a menu, not the link.
  if (e.type === "auxclick" && e.button !== 1) return;
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const link = target.closest<HTMLAnchorElement>("a[href]");
  // Any link to another origin leaves the dash; in-dash links are same-origin hashes.
  if (link && /^https?:/.test(link.href) && link.origin !== location.origin) {
    const { kind, host, ticket } = classifyHref(link.href);
    return record(link, kind, host, ticket);
  }
  if (e.type !== "click") return;
  const button = target.closest("button");
  // Matched by label, so App.tsx needs no hook; a renamed label stops this count.
  if (button?.textContent?.trim() === "Copy resume") record(button, "copy_resume", "terminal", null);
}

document.addEventListener("click", onClick, true);
document.addEventListener("auxclick", onClick, true);
