import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Ticket, TicketDetail, TicketSource } from "../../shared/types.ts";
import type { OnTicketChange, TicketProvider, VerbResult } from "./provider.ts";

export interface LocalFilesProviderConfig {
  id: string;
  /** The key prefix, such as AD for AD-12. */
  prefix: string;
  /** The folder above the status folders. Empty: no tickets. */
  dir: string;
}

/** The status folders, in board order. The folder is the status, so a `mv` moves the ticket. */
const STATUS: { folder: string; name: string; category: Ticket["statusCategory"] }[] = [
  { folder: "todo", name: "To Do", category: "new" },
  { folder: "in-progress", name: "In Progress", category: "indeterminate" },
  { folder: "in-review", name: "In Review", category: "indeterminate" },
  { folder: "done", name: "Done", category: "done" },
  { folder: "canceled", name: "Canceled", category: "done" },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The page opens this to read the file; a browser cannot open a file:// link from an http page. */
export const localTicketUrl = (port: number, key: string): string => `http://127.0.0.1:${port}/api/local-ticket?key=${key}`;

/** Tickets that are markdown files: `<dir>/<status>/<PREFIX>-<n>-<slug>.md`, as agent-dash's own AD tickets are. */
export class LocalFilesProvider implements TicketProvider {
  readonly source: TicketSource;
  readonly prefixes: string[];
  readonly enabled: boolean;
  readonly exhaustive = true;
  private readonly cfg: LocalFilesProviderConfig;
  private readonly port: number;
  private readonly file: RegExp;
  private readonly heading: RegExp;

  constructor(cfg: LocalFilesProviderConfig, port: number) {
    this.cfg = cfg;
    this.port = port;
    this.source = { id: cfg.id, label: `${cfg.prefix} tickets`, dueDate: false, move: true };
    this.prefixes = [cfg.prefix];
    // An empty dir would read `todo/` and so on relative to the server's cwd.
    this.enabled = !!cfg.dir;
    const p = escape(cfg.prefix);
    this.file = new RegExp(`^(${p}-\\d+)(?:-.*)?\\.md$`);
    this.heading = new RegExp(`^#\\s+(?:${p}-\\d+\\s*[—:-]\\s*)?(.+)$`, "m");
  }

  /** Every ticket in the folder, done ones too. A missing folder means no tickets. */
  readAll(): Ticket[] {
    const out: Ticket[] = [];
    if (!this.enabled) return out;
    for (const status of STATUS) {
      let names: string[];
      try {
        names = readdirSync(join(this.cfg.dir, status.folder));
      } catch {
        continue;
      }
      for (const name of names) {
        const key = this.file.exec(name)?.[1];
        if (!key) continue;
        const file = join(this.cfg.dir, status.folder, name);
        const text = readFileSync(file, "utf8");
        out.push({
          key,
          url: this.ticketUrl(key),
          file,
          // The heading is `# AD-1 — Title`; without one, the slug is the title.
          summary: this.heading.exec(text)?.[1].trim() ?? name.replace(new RegExp(`^${escape(this.cfg.prefix)}-\\d+-?|\\.md$`, "g"), "").replace(/-/g, " "),
          status: status.name,
          statusCategory: status.category,
          priority: null,
          dueDate: null,
          updatedAt: statSync(file).mtime.toISOString(),
          assignedToMe: true,
          source: this.source,
        });
      }
    }
    return out;
  }

  private find(key: string): Ticket | undefined {
    return this.readAll().find((t) => t.key === key);
  }

  ticketUrl(key: string): string {
    return localTicketUrl(this.port, key);
  }

  async listMine(): Promise<Ticket[]> {
    return this.readAll().filter((t) => t.statusCategory !== "done");
  }

  async lookup(keys: string[]): Promise<Ticket[]> {
    const want = new Set(keys);
    return this.readAll().filter((t) => want.has(t.key));
  }

  /** The file below its heading. There are no comments; the transitions are the other status folders. */
  async detail(key: string): Promise<TicketDetail | null> {
    const t = this.find(key);
    if (!t) return null;
    return {
      key,
      status: t.status,
      dueDate: null,
      description: readFileSync(t.file!, "utf8").replace(/^#\s+.*\n+/, "").trim(),
      comments: [],
      commentTotal: 0,
      transitions: STATUS.filter((s) => s.name !== t.status).map((s) => ({ id: s.folder, name: s.name, to: s.name })),
      fetchedAt: new Date().toISOString(),
    };
  }

  agentReadStep(key: string): string {
    return `2. ${key} is a local ticket: a markdown file. Read the file named as "Ticket file" in the context file.`;
  }

  /** Move the file into the other status folder, if it is still in the folder that the page showed. */
  async move(key: string, to: string, from: string, onChange: OnTicketChange): Promise<VerbResult> {
    const t = this.find(key);
    if (!t) return { status: 404, body: { error: `no ticket file for ${key}` } };
    if (t.status !== from) return { status: 409, body: { error: `${key} is now "${t.status}". Reload the ticket and pick the status again.` } };
    const target = STATUS.find((s) => s.name === to);
    if (!target) return { status: 409, body: { error: `${key} cannot move to "${to}": the statuses are ${STATUS.map((s) => s.name).join(", ")}.` } };
    mkdirSync(join(this.cfg.dir, target.folder), { recursive: true });
    renameSync(t.file!, join(this.cfg.dir, target.folder, basename(t.file!)));
    onChange(key, { status: target.name, statusCategory: target.category });
    return { status: 200, body: { key, from, to: target.name, dueDate: null } };
  }

  rawText(key: string): string | null {
    // Only a file that the folder scan found, so a key cannot name a path.
    const t = this.find(key);
    return t?.file ? `${t.file}\n\n${readFileSync(t.file, "utf8")}` : null;
  }
}
