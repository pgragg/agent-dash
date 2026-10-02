import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunStatus } from "../../shared/types.ts";

export interface ReportedStatus {
  sessionId: string;
  pid: number;
  itermSessionId?: string | null;
  state: "working" | "awaiting_input" | "closed";
  since: string;
}

export async function readReportedStatuses(dir: string): Promise<Map<string, ReportedStatus>> {
  const out = new Map<string, ReportedStatus>();
  if (!existsSync(dir)) return out;
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(await readFile(join(dir, f), "utf8")) as ReportedStatus;
      if (s.sessionId) out.set(s.sessionId, s);
    } catch {
      // Skip a file that is mid-write or corrupt; the next scan reads it again.
    }
  }
  return out;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A killed pi process never writes "closed", so a dead pid also means finished. */
export function resolveReported(s: ReportedStatus, alive: (pid: number) => boolean = isAlive): { status: RunStatus; since: string } {
  if (s.state === "closed" || !alive(s.pid)) return { status: "finished", since: s.since };
  return { status: s.state, since: s.since };
}
