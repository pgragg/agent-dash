/**
 * Claude Code asks before a tool runs. The hook shows that question on the page as a confirm
 * dialog, and the server answers it on the headless run's stdin. Both make the title here, so the
 * server answers only the request that the status file shows.
 */

function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What the tool acts on: a command, a path or a pattern. File contents never go on the page. */
export function toolTarget(input: unknown): string {
  const a = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "url"]) if (typeof a[k] === "string") return a[k] as string;
  return "";
}

export function permissionTitle(tool: string, input: unknown): string {
  const target = toolTarget(input);
  return cut(`Allow ${tool}${target ? `: ${target}` : ""}?`, 200);
}
