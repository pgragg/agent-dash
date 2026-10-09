import { useState } from "react";
import type { HistoryRun } from "../../shared/types.ts";
import { usage } from "./usage.ts";

/** The custom header makes the browser send a CORS preflight, which the server never answers. */
async function postJson(path: string, body?: unknown): Promise<{ sessionId?: string }> {
  const res = await fetch(path, { method: "POST", headers: { "X-Agent-Dash": "1", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? json.detail ?? `failed (${res.status})`);
  return json;
}

export interface LaunchBody {
  /** Your first message, or the id of a drafted step that the server turns into one. */
  message?: string;
  step?: number;
  cwd: string;
  /** Open pi in a new iTerm tab instead of headless. */
  terminal?: boolean;
  /** An SDLC verb; the server writes its message, because the message names the server's script path. */
  sdlc?: { kind: "smoketest_plan"; env: string } | { kind: "confirm_deploy"; stage: "beta" | "prod" };
}

/** Starts an agent on a ticket. Resolves to its session id (null in iTerm, which picks its own), or throws the reason. */
export async function launchAgent(ticket: string, body: LaunchBody): Promise<string | null> {
  return (await postJson(`/api/agents?ticket=${encodeURIComponent(ticket)}`, body)).sessionId ?? null;
}

export function conversationHash(sessionId: string): string {
  return `#/c:${encodeURIComponent(sessionId)}`;
}

/** When each run was resumed from this page. The page data says "finished" until pi writes its status file. */
const resumedAt = new Map<string, number>();

export function resuming(sessionId: string): boolean {
  return Date.now() - (resumedAt.get(sessionId) ?? 0) < 30_000;
}

/** Continues a finished session headless, under its own id, and opens its page. */
export function ResumeHere({ run, onError, small = false }: { run: HistoryRun; onError: (m: string | null) => void; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`btn ${small ? "small" : ""}`}
      disabled={busy || resuming(run.sessionId)}
      title="Continue this session on its page, with no terminal"
      {...usage("resume-here")}
      onClick={async () => {
        setBusy(true);
        try {
          const id = (await postJson(`/api/conversations/resume?session=${encodeURIComponent(run.sessionId)}`)).sessionId ?? run.sessionId;
          resumedAt.set(id, Date.now());
          onError(null);
          location.hash = conversationHash(id);
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy || resuming(run.sessionId) ? "Resuming…" : "Resume here"}
    </button>
  );
}
