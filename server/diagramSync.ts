import { stat } from "node:fs/promises";
import { loadImage } from "./diagrams.ts";
import type { ParsedSession } from "./sources/sessions.ts";
import * as db from "./summaries/db.ts";

/** The mtime of each embedded image when it was last read, by "<session> <path>", so a file is read once per change. */
const readAt = new Map<string, number>();

/**
 * Stores each diagram that is new, and moves a conversation's diagrams to its ticket when it
 * gets one. Each write reloads the page, which calls this again, so it writes only on a change.
 */
export async function syncDiagrams(sessions: ParsedSession[], ticketOf: (s: ParsedSession) => string | null, now = new Date()): Promise<void> {
  const known = db.diagramKeys();
  const rows: db.NewDiagram[] = [];
  // The tickets that each conversation's stored diagrams have, to see when the conversation's ticket moved.
  const storedTickets = new Map<string, Set<string | null>>();
  for (const d of db.listDiagrams()) (storedTickets.get(d.sessionId) ?? storedTickets.set(d.sessionId, new Set()).get(d.sessionId)!).add(d.ticket);
  for (const s of sessions) {
    const found = s.diagrams ?? [];
    if (!found.length) continue;
    const ticket = ticketOf(s);
    for (const f of found) {
      const base = { sessionId: s.sessionId, ticket, title: f.title, origin: f.origin, createdAt: f.at ?? now.toISOString() };
      if (f.kind !== "file") {
        const key = `${s.sessionId} ${f.hash}`;
        if (!known.has(key)) rows.push({ ...base, key, kind: f.kind, hash: f.hash, source: f.source });
        known.add(key);
        continue;
      }
      const memo = `${s.sessionId} ${f.path}`;
      const mtime = (await stat(f.path).catch(() => null))?.mtimeMs;
      if (mtime === undefined || readAt.get(memo) === mtime) continue;
      readAt.set(memo, mtime);
      const img = await loadImage(f.path);
      if (!img) continue;
      const key = `${s.sessionId} ${img.hash}`;
      if (!known.has(key)) rows.push({ ...base, key, kind: img.kind, hash: img.hash, source: img.source });
      known.add(key);
    }
    if (ticket && [...(storedTickets.get(s.sessionId) ?? [])].some((t) => t !== ticket)) db.setDiagramTicket(s.sessionId, ticket);
  }
  db.addDiagrams(rows);
}
