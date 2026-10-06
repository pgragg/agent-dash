/**
 * Make every session of the configured agent report to agent-dash, also one that the dash did
 * not start. pi: symlink the status extension into pi's global extension folder. Claude Code: add
 * the status hooks to ~/.claude/settings.json. `--agent pi|claude` picks the other agent.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { installClaudeHooks } from "../server/agent.ts";
import { config } from "../server/config.ts";

const flag = process.argv.indexOf("--agent");
const agent = flag >= 0 ? process.argv[flag + 1] : config.agent;

if (agent === "claude") {
  console.log(installClaudeHooks());
  process.exit(0);
}
if (agent !== "pi") {
  console.error(`--agent must be pi or claude, not ${agent}`);
  process.exit(1);
}

// A symlink, not a copy, so a `git pull` here also updates the extension.
const source = new URL("../extension/agent-dash-status.ts", import.meta.url).pathname;
const target = join(process.env.PI_EXTENSIONS_DIR ?? join(homedir(), ".pi/agent/extensions"), "agent-dash-status.ts");

mkdirSync(dirname(target), { recursive: true });
if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
  const isOurLink = lstatSync(target).isSymbolicLink() && readlinkSync(target) === source;
  if (isOurLink) {
    console.log(`Already installed: ${target} -> ${source}`);
    process.exit(0);
  }
  if (!process.argv.includes("--force")) {
    console.error(`${target} exists and is not our symlink. Re-run with --force to replace it.`);
    process.exit(1);
  }
  unlinkSync(target);
}
symlinkSync(source, target);
console.log(`Installed: ${target} -> ${source}`);
console.log("New pi sessions load it at once. In a running session, type /reload.");
