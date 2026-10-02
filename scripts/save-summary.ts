/**
 * Save a next-steps summary that a summary run wrote. The summary run calls this itself:
 *
 *   node scripts/save-summary.ts <id> < summary.md
 *
 * Sets status "done" and generated_at. Exits non-zero if the request is unknown or no
 * longer in progress (for example, it was re-requested), so the agent can see it.
 */
import { readFileSync } from "node:fs";
import * as db from "../server/summaries/db.ts";

const id = Number(process.argv[2]);
if (!Number.isInteger(id)) {
  console.error("usage: node scripts/save-summary.ts <id> < summary.md");
  process.exit(2);
}
const summary = readFileSync(0, "utf8").trim();
if (!summary) {
  console.error("empty summary on stdin");
  process.exit(2);
}
if (!db.markDone(id, summary)) {
  const rec = db.get(id);
  console.error(rec ? `request ${id} is ${rec.status}, not in progress; not saved` : `no request ${id}`);
  process.exit(1);
}
console.log(`saved summary ${id} for ${db.get(id)!.ticket}`);
