import type { Usage } from "../../shared/exits.ts";

/**
 * Records view opens and queue control clicks, so a usage audit reads one table. A control opts
 * in with `{...usage(name, ticket)}`, and one capturing listener counts it, so no handler changes.
 */

function send(u: Usage): void {
  // A lost row must never break the click, so this never throws or waits.
  fetch("/api/usage", { method: "POST", keepalive: true, headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: JSON.stringify(u) }).catch(() => {});
}

/** The attributes that make a button count its clicks. */
export const usage = (name: string, ticket?: string | null) => ({ "data-usage": name, "data-ticket": ticket ?? undefined });

let lastView: string | null = null;

/** Adds a row only when the view is not the one recorded last, so a re-render or a poll adds none. */
export function recordView(name: string): void {
  if (name === lastView) return;
  lastView = name;
  send({ kind: "view", name, ticket: null });
}

document.addEventListener(
  "click",
  (e) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-usage]") : null;
    if (el?.dataset.usage) send({ kind: "control", name: el.dataset.usage, ticket: el.dataset.ticket ?? null });
  },
  true,
);
