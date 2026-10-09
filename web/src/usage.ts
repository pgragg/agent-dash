import type { Usage } from "../../shared/exits.ts";

/**
 * Records view opens and queue control uses, so a usage audit reads one table. A button opts in
 * with `{...usage(name, ticket)}`, and one capturing listener counts its clicks. A control that a
 * key also fires calls `recordControl` in its action instead, so one action is one row.
 */

function send(u: Usage): void {
  // A lost row must never break the click, so this never throws or waits.
  fetch("/api/usage", { method: "POST", keepalive: true, headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: JSON.stringify(u) }).catch(() => {});
}

/** For a control that a key also fires: call it where the action happens, not in each trigger. */
export const recordControl = (name: string, ticket?: string | null) => send({ kind: "control", name, ticket: ticket ?? null });

/** The attributes that make a button count its clicks. */
export const usage = (name: string, ticket?: string | null) => ({ "data-usage": name, "data-ticket": ticket ?? undefined });

// Per tab, and kept over a reload: a restart or a new build reloads every open tab, which is no view open.
const LAST_VIEW = "agent-dash:usage-view";

/** Adds a row only when the view is not the one this tab recorded last, so a re-render, a poll or a reload adds none. */
export function recordView(name: string): void {
  if (name === sessionStorage.getItem(LAST_VIEW)) return;
  sessionStorage.setItem(LAST_VIEW, name);
  send({ kind: "view", name, ticket: null });
}

document.addEventListener(
  "click",
  (e) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-usage]") : null;
    if (el?.dataset.usage) recordControl(el.dataset.usage, el.dataset.ticket);
  },
  true,
);
