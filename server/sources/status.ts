import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunActivity, RunDialog, RunStatus } from "../../shared/types.ts";

export interface ReportedStatus {
  sessionId: string;
  pid: number;
  /** The folder pi started in. */
  cwd?: string;
  itermSessionId?: string | null;
  /** The extension watches ~/.agent-dash/inbox/<sessionId>/ for replies typed in the dash. */
  inbox?: boolean;
  /** pi's mode: "rpc" is a headless conversation that the dash started. */
  mode?: string;
  state: "working" | "awaiting_input" | "closed";
  since: string;
  /** 2 and later: the extension reads *.steer and *.abort files, and reports activity and dialogs. */
  version?: number;
  activity?: RunActivity | null;
  dialog?: RunDialog | null;
}

/** The extension of this session acts on Stop and Steer files. An older one reads only *.txt. */
export function takesControls(s: ReportedStatus | undefined): boolean {
  return Boolean(s?.inbox) && (s?.version ?? 1) >= 2;
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
  // An open dialog blocks the run until you answer it, so it waits for you.
  if (s.dialog) return { status: "awaiting_input", since: s.dialog.since };
  return { status: s.state, since: s.since };
}
