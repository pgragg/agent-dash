/**
 * "Snooze until something changes" (`E`) hides a queue entry while its fingerprint is the same.
 * SQLite keeps the marks, so every origin of the page sees the same ones.
 */

/** Entry id to the fingerprint it had at the click. */
export type Marks = Record<string, string>;
/** Clicks that the server did not confirm yet: a fingerprint, or null for "Back to the queue". */
export type Pending = Record<string, string | null>;

/** The marks that the page shows: the server's, with the clicks still on their way on top. */
export function withPending(server: Marks, pending: Pending): Marks {
  const out = { ...server };
  for (const [id, fp] of Object.entries(pending)) {
    if (fp === null) delete out[id];
    else out[id] = fp;
  }
  return out;
}

/** Drops the clicks that the server's marks show now. A click stays until then, so an older load cannot undo it. */
export function settle(server: Marks, pending: Pending): Pending {
  const out: Pending = {};
  for (const [id, fp] of Object.entries(pending)) if ((server[id] ?? null) !== fp) out[id] = fp;
  return out;
}

export function isMarked(marks: Marks, s: { id: string; fingerprint: string }): boolean {
  return marks[s.id] === s.fingerprint;
}

/** Where the page kept the marks before SQLite did, one copy for each origin. */
export const LEGACY_KEY = "agent-dash:done-for-now";

type Storage = Pick<globalThis.Storage, "getItem" | "removeItem">;

/**
 * Sends this origin's old localStorage marks to the server one time, then removes the key.
 * The key stays when the send fails, so the next load tries again. The server keeps a mark that
 * it has already, so a second send changes nothing.
 */
export async function importLegacy(storage: Storage, send: (marks: Marks) => Promise<string | null>): Promise<void> {
  const raw = storage.getItem(LEGACY_KEY);
  if (raw === null) return;
  let marks: unknown;
  try {
    marks = JSON.parse(raw);
  } catch {
    marks = null;
  }
  const valid = marks && typeof marks === "object" && !Array.isArray(marks) ? Object.fromEntries(Object.entries(marks).filter(([, v]) => typeof v === "string")) : {};
  if (Object.keys(valid).length && (await send(valid as Marks)) !== null) return;
  storage.removeItem(LEGACY_KEY);
}
