/**
 * Ranks the exits from agent-dash to other tools, most used first. Reads SQLite directly,
 * so it works when the server is down.
 *
 *   pnpm exits [days]      (default 7)
 */
import { exitCounts } from "../server/exits.ts";

const days = Number(process.argv[2] ?? 7);
if (!(days > 0)) {
  console.error("usage: pnpm exits [days]");
  process.exit(2);
}

const counts = exitCounts(days);
if (!counts.length) {
  console.log(`No exits in the last ${days} days.`);
  process.exit(0);
}
const total = counts.reduce((n, c) => n + c.count, 0);
const width = Math.max(...counts.map((c) => `${c.kind} · ${c.section || "(unknown)"}`.length));
console.log(`Exits in the last ${days} days: ${total}\n`);
for (const c of counts) console.log(`${`${c.kind} · ${c.section || "(unknown)"}`.padEnd(width)} · ${c.count}`);
