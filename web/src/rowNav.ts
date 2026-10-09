/**
 * J/K and Enter on the list views (PRs, History, Wiki). The selection is a data attribute on the
 * row, not React state, so the views need no changes and a re-render keeps it.
 */
const ROWS = ".main .pr-entry, .main ol.history > li";
/** The row's main link or button: Enter does what a click on it does. */
const OPEN = "a.pr-row, .h-title";
const MARK = "data-nav-selected";

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(ROWS)];
}

/** Handles the key on a list view; false when the key is not one of these. */
export function rowKey(key: string): boolean {
  const all = rows();
  const i = all.findIndex((r) => r.hasAttribute(MARK));
  // The arrows keep scrolling these long pages.
  if ((key === "j" || key === "k") && all.length) {
    const down = key === "j";
    const next = all[i < 0 ? 0 : Math.max(0, Math.min(all.length - 1, i + (down ? 1 : -1)))];
    all[i]?.removeAttribute(MARK);
    next.setAttribute(MARK, "");
    next.scrollIntoView({ block: "nearest" });
    return true;
  }
  // A focused button or link takes Enter itself.
  if (key === "Enter" && i >= 0 && (!document.activeElement || document.activeElement === document.body)) {
    all[i].querySelector<HTMLElement>(OPEN)?.click();
    return true;
  }
  return false;
}
