import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The last good answer of a slow source, kept on disk. After a restart the first build shows it at
 * once and asks the source again in the background: GitHub alone takes about 6 s.
 */
export interface DiskEntry<T> {
  value: T;
  fetchedAt: string;
}

/** Null when there is no file, or when it is not valid: the source is then read as on a first start. */
export function readDiskCache<T>(file: string): DiskEntry<T> | null {
  try {
    const e = JSON.parse(readFileSync(file, "utf8")) as DiskEntry<T>;
    return e && "value" in e && !Number.isNaN(Date.parse(e.fetchedAt)) ? e : null;
  } catch {
    return null;
  }
}

/** Best effort: a failed write only costs the next restart its head start. */
export async function writeDiskCache<T>(file: string, value: T, fetchedAt: string): Promise<void> {
  try {
    mkdirSync(dirname(file), { recursive: true });
    // A rename is atomic, so a restart never reads half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ value, fetchedAt } satisfies DiskEntry<T>));
    await rename(tmp, file);
  } catch (err) {
    console.warn(`agent-dash: could not write ${file}: ${(err as Error).message}`);
  }
}
