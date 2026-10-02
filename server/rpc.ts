import { closeSync, constants, openSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import type { RunDialog } from "../shared/types.ts";

/**
 * Talk to a headless pi (`--mode rpc`) through its files: stdout is a log, stdin is a FIFO.
 * Only the extension UI sub-protocol is used here; replies still go through the inbox.
 */

export interface UiRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export type UiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/** A dialog blocks the run, so it sits near the end of the log; the whole log can be large. */
const TAIL_BYTES = 512 * 1024;

/**
 * The newest dialog request in the log text that has no answer yet. The log does not hold
 * the answers (they go to stdin), so the caller says which ids it answered.
 */
export function newestOpenDialog(log: string, answered: ReadonlySet<string>): UiRequest | null {
  // rpc framing splits on LF only; U+2028 inside a JSON string is not a line end.
  const lines = log.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"extension_ui_request"')) continue;
    try {
      const msg = JSON.parse(line) as UiRequest;
      if (msg.type === "extension_ui_request" && DIALOGS.has(msg.method) && typeof msg.id === "string" && !answered.has(msg.id)) return msg;
    } catch {
      // A line cut by the tail read, or a half-written last line.
    }
  }
  return null;
}

export async function readLogTail(file: string, bytes = TAIL_BYTES): Promise<string> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // The first line of a tail read is partial.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await fh.close();
  }
}

/** The status file cuts long titles to one line, so compare from the start, without the "…". */
export function sameDialog(req: UiRequest, dialog: RunDialog): boolean {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  return req.method === dialog.method && norm(req.title ?? "").startsWith(norm(dialog.title).replace(/…$/, ""));
}

/** The response line for a request, or an error message when the answer does not fit it. */
export function uiResponse(req: UiRequest, answer: UiAnswer): { line: string } | { error: string } {
  const base = { type: "extension_ui_response", id: req.id };
  if ("cancelled" in answer) return { line: JSON.stringify({ ...base, cancelled: true }) };
  if (req.method === "confirm") {
    if (!("confirmed" in answer) || typeof answer.confirmed !== "boolean") return { error: "a confirm dialog takes yes or no" };
    return { line: JSON.stringify({ ...base, confirmed: answer.confirmed }) };
  }
  if (!("value" in answer) || typeof answer.value !== "string") return { error: "this dialog takes a value" };
  if (req.method === "select" && !req.options?.includes(answer.value)) return { error: "not one of the options" };
  return { line: JSON.stringify({ ...base, value: answer.value }) };
}

/**
 * Write one line to the FIFO without blocking. pi holds the FIFO open read-write, so an open
 * for write succeeds at once; with no reader it fails with ENXIO instead of hanging.
 */
export function writeFifoLine(fifo: string, line: string): void {
  const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  try {
    const buf = Buffer.from(`${line}\n`);
    let off = 0;
    const deadline = Date.now() + 2_000;
    while (off < buf.length) {
      try {
        off += writeSync(fd, buf, off);
      } catch (err) {
        // A full pipe empties as pi reads; wait a little, but not for ever.
        if ((err as NodeJS.ErrnoException).code !== "EAGAIN" || Date.now() > deadline) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } finally {
    closeSync(fd);
  }
}
