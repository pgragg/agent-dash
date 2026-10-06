import { closeSync, constants, openSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { permissionTitle } from "../shared/claudeDialog.ts";
import type { RunDialog } from "../shared/types.ts";

/**
 * Talk to a headless agent through its files: stdout is a log, stdin is a FIFO. For pi only the
 * extension UI sub-protocol is used here; its replies go through the inbox. Claude Code asks
 * before a tool call with a `can_use_tool` control request, which shows as a confirm dialog.
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

/** A select is answered by option index: the status file shows options cut to one line. */
export type UiAnswer = { value: string } | { index: number } | { confirmed: boolean } | { cancelled: true };

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

/** A Claude Code permission request, as a confirm dialog with the title that the hook shows. */
export interface ClaudeRequest extends UiRequest {
  input: unknown;
}

/** The newest permission request in a Claude Code log that this server did not answer. */
export function newestOpenClaudeRequest(log: string, answered: ReadonlySet<string>): ClaudeRequest | null {
  const lines = log.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"can_use_tool"')) continue;
    try {
      const msg = JSON.parse(lines[i]) as { type?: string; request_id?: string; request?: { subtype?: string; tool_name?: string; input?: unknown } };
      if (msg.type !== "control_request" || msg.request?.subtype !== "can_use_tool" || typeof msg.request_id !== "string" || answered.has(msg.request_id)) continue;
      const tool = msg.request.tool_name ?? "";
      return { type: "extension_ui_request", id: msg.request_id, method: "confirm", title: permissionTitle(tool, msg.request.input), input: msg.request.input };
    } catch {
      // A line cut by the tail read, or a half-written last line.
    }
  }
  return null;
}

/** Yes runs the tool as the agent asked; no and Stop deny it, and the agent hears why. */
export function claudeResponse(req: ClaudeRequest, answer: UiAnswer): { line: string } | { error: string } {
  const allow = "confirmed" in answer ? answer.confirmed : "cancelled" in answer ? false : null;
  if (typeof allow !== "boolean") return { error: "a confirm dialog takes yes or no" };
  const response = allow ? { behavior: "allow", updatedInput: req.input ?? {} } : { behavior: "deny", message: "The user denied this tool call in agent-dash." };
  return { line: JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: req.id, response } }) };
}

export async function readLogTail(file: string, bytes = TAIL_BYTES): Promise<string> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const text = buf.subarray(0, bytesRead).toString("utf8");
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
  if (req.method === "select") {
    const value = "index" in answer ? req.options?.[answer.index] : "value" in answer && req.options?.includes(answer.value) ? answer.value : undefined;
    if (typeof value !== "string") return { error: "not one of the options" };
    return { line: JSON.stringify({ ...base, value }) };
  }
  if (!("value" in answer) || typeof answer.value !== "string") return { error: "this dialog takes a value" };
  return { line: JSON.stringify({ ...base, value: answer.value }) };
}

/**
 * Write one line to the FIFO, however long, without blocking the server: the agent can take some
 * seconds to start reading. Fails at once when nothing reads the FIFO.
 */
export async function writeFifoSoon(fifo: string, line: string, timeoutMs = 120_000): Promise<void> {
  const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  try {
    const buf = Buffer.from(`${line}\n`);
    const deadline = Date.now() + timeoutMs;
    for (let off = 0; off < buf.length; ) {
      try {
        off += writeSync(fd, buf, off);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EAGAIN" || Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } finally {
    closeSync(fd);
  }
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
