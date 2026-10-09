import type { HistoryRun } from "../../shared/types.ts";

/** Search and day groups for the History view. Kept free of React so the tests can import it. */

/** Every word must appear in the run's name, prompt, last reply, folder or tickets. */
export function filterHistory(runs: HistoryRun[], query: string): HistoryRun[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return runs;
  return runs.filter((r) => {
    const hay = [r.name ?? "", r.title ?? "", r.firstPrompt, r.lastReply, r.cwd, r.sessionId, ...r.tickets, ...r.createdPrs].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export interface DayGroup {
  label: string;
  runs: HistoryRun[];
}

/** "Today", "Yesterday", then "Mon, Sep 28", by the day of the run's last activity. Input is newest first. */
export function groupByDay(runs: HistoryRun[], now: number): DayGroup[] {
  const dayOf = (t: number) => new Date(t).toDateString();
  const today = dayOf(now);
  const yesterday = dayOf(now - 86_400_000);
  const groups: DayGroup[] = [];
  for (const r of runs) {
    const t = Date.parse(r.lastActivityAt);
    const day = dayOf(t);
    const label = day === today ? "Today" : day === yesterday ? "Yesterday" : new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    if (groups.at(-1)?.label !== label) groups.push({ label, runs: [] });
    groups.at(-1)!.runs.push(r);
  }
  return groups;
}
