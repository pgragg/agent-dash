/**
 * Make every session of the configured agent report to agent-dash, also one that the dash did
 * not start. pi: symlink the status extension into pi's global extension folder. Claude Code: add
 * the status hooks to ~/.claude/settings.json. OpenCode: nothing, as the dash asks its service.
 * `--agent pi|claude|opencode` picks another agent.
 */
import { installClaudeHooks, installPiExtension } from "../server/agent.ts";
import { config } from "../server/config.ts";

const flag = process.argv.indexOf("--agent");
const agent = flag >= 0 ? process.argv[flag + 1] : config.agent;

if (agent === "claude") {
  console.log(installClaudeHooks());
  process.exit(0);
}
if (agent === "opencode") {
  console.log("Nothing to install: agent-dash asks OpenCode's background service for the status of every session.");
  process.exit(0);
}
if (agent !== "pi") {
  console.error(`--agent must be pi, claude or opencode, not ${agent}`);
  process.exit(1);
}

try {
  console.log(installPiExtension(process.argv.includes("--force")));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
