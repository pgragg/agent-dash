/** The demo's `pi`: one-turn drafts only, answered from world.ts. It never calls a model. */
import { readFileSync } from "node:fs";
import { NEXT_STEPS, PRS, RUNS, STEP_LABELS } from "./world.ts";

const args = process.argv.slice(2);
const prompt = readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8");
const say = (text: string) => process.stdout.write(`${text}\n`);

if (!args.includes("-p")) {
  process.stderr.write("demo pi: only `pi -p` drafts are faked; the demo starts no live agent\n");
  process.exit(1);
}

if (prompt.startsWith("Write a next-steps summary for ticket")) {
  const key = prompt.match(/ticket (\S+)\./)?.[1] ?? "";
  if (!NEXT_STEPS[key]) process.exit(1);
  say(NEXT_STEPS[key].text);
} else if (prompt.startsWith("Summarise this conversation")) {
  const run = RUNS.find((r) => r.turns.some((t) => "user" in t && prompt.includes(t.user)));
  if (!run) process.exit(1);
  const g = run.gist;
  say([g.title && `TITLE: ${g.title}`, `ABOUT: ${g.about}`, `LATEST: ${g.latest}`, `NEEDS: ${g.needs}`].filter(Boolean).join("\n"));
} else if (prompt.startsWith("A kanban card for ticket")) {
  const key = prompt.match(/ticket (\S+) has/)?.[1] ?? "";
  say(STEP_LABELS[key] ?? "Agent starts the next step");
} else if (prompt.startsWith("Write the middle of a Slack message")) {
  const title = prompt.match(/^Title: (.+)$/m)?.[1];
  const pr = PRS.find((p) => p.title === title);
  if (!pr) process.exit(1);
  say(pr.draftPhrase);
} else {
  process.stderr.write("demo pi: no fixture for this prompt\n");
  process.exit(1);
}
