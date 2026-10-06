import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ticket, TicketDetail } from "../../shared/types.ts";

/**
 * agent-dash's own work items are markdown files, not Jira issues: `<dir>/<status>/AD-<n>-<slug>.md`.
 * The folder is the status, so a `mv` moves the ticket.
 */
const STATUS: Record<string, { name: string; category: Ticket["statusCategory"] }> = {
  todo: { name: "To Do", category: "new" },
  "in-progress": { name: "In Progress", category: "indeterminate" },
  "in-review": { name: "In Review", category: "indeterminate" },
  done: { name: "Done", category: "done" },
  canceled: { name: "Canceled", category: "done" },
};

const FILE = /^(AD-\d+)(?:-.*)?\.md$/;

export const isLocalKey = (key: string): boolean => /^AD-\d+$/.test(key);

/** The page opens this to read the file; a browser cannot open a file:// link from an http page. */
export const localTicketUrl = (port: number, key: string): string => `http://127.0.0.1:${port}/api/local-ticket?key=${key}`;

/** Every AD ticket in the folder, done ones too. A missing folder, or none set, means no tickets. */
export function readLocalTickets(dir: string, port: number): Ticket[] {
  const out: Ticket[] = [];
  // An empty dir would read `todo/` and so on relative to the server's cwd.
  if (!dir) return out;
  for (const [folder, status] of Object.entries(STATUS)) {
    let names: string[];
    try {
      names = readdirSync(join(dir, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      const key = FILE.exec(name)?.[1];
      if (!key) continue;
      const file = join(dir, folder, name);
      const text = readFileSync(file, "utf8");
      out.push({
        key,
        url: localTicketUrl(port, key),
        file,
        // The heading is `# AD-1 — Title`; without one, the slug is the title.
        summary: /^#\s+(?:AD-\d+\s*[—:-]\s*)?(.+)$/m.exec(text)?.[1].trim() ?? name.replace(/^AD-\d+-?|\.md$/g, "").replace(/-/g, " "),
        status: status.name,
        statusCategory: status.category,
        priority: null,
        dueDate: null,
        updatedAt: statSync(file).mtime.toISOString(),
        assignedToMe: true,
      });
    }
  }
  return out;
}

/** The ticket section's content: the file below its heading. There are no comments or transitions. */
export function localTicketDetail(ticket: Ticket): TicketDetail {
  const text = ticket.file ? readFileSync(ticket.file, "utf8") : "";
  return {
    key: ticket.key,
    status: ticket.status,
    dueDate: null,
    description: text.replace(/^#\s+.*\n+/, "").trim(),
    comments: [],
    commentTotal: 0,
    transitions: [],
    fetchedAt: new Date().toISOString(),
  };
}
