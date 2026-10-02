import type { RunActivity } from "./types.ts";

const VERBS: Record<string, string> = { bash: "running", read: "reading", edit: "editing", write: "writing", grep: "searching", find: "finding", ls: "listing" };

function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The parts of the line "running `pnpm test` · 40s" for the tool that runs now. */
export function activityParts(a: RunActivity, now: number): { verb: string; code: string; elapsed: string } {
  const verb = VERBS[a.tool] ?? `using ${a.tool}`;
  return { verb, code: a.summary, elapsed: seconds(now - Date.parse(a.since)) };
}
