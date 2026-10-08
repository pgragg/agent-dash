/**
 * One OpenCode turn for a draft or a summary, with its text on stdout, as `pi -p` and `claude -p`
 * give it. OpenCode has no session-less run, so this makes a session with its own tool rules,
 * runs `opencode run` on it, and deletes it at the end.
 *
 *   node server/opencode-oneshot.ts <draft|summary> [--model provider/model] [--title text] --prompt-file <file>
 *
 * It deletes the prompt file once it has read it.
 */

import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { newOpencodeSessionId, ONESHOT_TITLE, opencodeApi, opencodeCreate, type PermissionRule } from "./opencode.ts";

/** A draft is text only. `opencode run` cannot ask, so a rule of "ask" would stop the turn. */
const NO_TOOLS: PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];
/** A summary reads files and runs read-only commands, as the pi and Claude Code summaries do. The last matching rule wins. */
const READ_AND_SHELL: PermissionRule[] = [...NO_TOOLS, ...["read", "glob", "grep", "shell", "external_directory"].map((action): PermissionRule => ({ action, resource: "*", effect: "allow" }))];

export function oneshotArgs(argv: string[]): { mode: "draft" | "summary"; model?: string; title: string; promptFile: string } {
  const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const mode = argv[0];
  if (mode !== "draft" && mode !== "summary") throw new Error("the first argument must be draft or summary");
  const promptFile = flag("--prompt-file");
  if (!promptFile) throw new Error("--prompt-file is missing");
  return { mode, model: flag("--model"), title: flag("--title") ?? mode, promptFile };
}

async function main(): Promise<number> {
  const o = oneshotArgs(process.argv.slice(2));
  const prompt = readFileSync(o.promptFile, "utf8");
  rmSync(o.promptFile, { force: true });
  const sessionId = newOpencodeSessionId();
  await opencodeCreate({ sessionId, cwd: process.cwd(), title: `${ONESHOT_TITLE}: ${o.title}`, model: o.model, permissions: o.mode === "draft" ? NO_TOOLS : READ_AND_SHELL });
  const remove = () => opencodeApi("DELETE", `/api/session/${sessionId}`).catch(() => {});
  // The prompt goes on stdin: `opencode run` puts quotes around an argument that has a space.
  const child = spawn("opencode", ["run", "--session", sessionId], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.end(prompt);
  // A summary that runs too long gets SIGTERM: stop the turn, and still delete the session.
  process.on("SIGTERM", () => child.kill("SIGINT"));
  const code = await new Promise<number>((resolve) => {
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", (err) => {
      console.error(`could not start opencode: ${err.message}`);
      resolve(127);
    });
  });
  await remove();
  return code;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
