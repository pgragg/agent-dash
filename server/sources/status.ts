import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  /** "rpc" is a headless conversation that the dash started. */
  mode?: string;
  /** Set by the Claude Code hook. A file without it comes from the pi extension. */
  agent?: "claude";
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

/** Claude Code has no steer: a message waits until the current turn ends. */
export function takesSteer(s: ReportedStatus | undefined): boolean {
  return takesControls(s) && s?.agent !== "claude";
}

export function readReportedStatus(dir: string, sessionId: string): ReportedStatus | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, `${sessionId}.json`), "utf8")) as ReportedStatus;
  } catch {
    return undefined;
  }
}

/**
 * Change a status file that the hooks own, for what no hook reports: Claude Code runs no Stop
 * hook after an interrupt, and no hook when the server answers a permission request.
 */
export function patchReportedStatus(dir: string, sessionId: string, patch: Partial<ReportedStatus>): void {
  const old = readReportedStatus(dir, sessionId);
  if (!old) return;
  const file = join(dir, `${sessionId}.json`);
  writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({ ...old, ...patch }));
  renameSync(`${file}.${process.pid}.tmp`, file);
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
