/**
 * Make every session of the configured agent report to agent-dash, also one that the dash did
 * not start. pi: symlink the status extension into pi's global extension folder. Claude Code: add
 * the status hooks to ~/.claude/settings.json. OpenCode: nothing, as the dash asks its service.
 * Then link each folder in `skills/` into the agent's skills folder. `--skills` does only that
 * (scripts/ship.sh runs it, so a new skill reaches the agent when it ships).
 * `--agent pi|claude|opencode` picks another agent.
 */
import { installClaudeHooks, installPiExtension, installSkills, skillsDir } from "../server/agent.ts";
import { config } from "../server/config.ts";
import type { AgentKind } from "../shared/team.ts";

const flag = process.argv.indexOf("--agent");
const agent = flag >= 0 ? process.argv[flag + 1] : config.agent;
const skills = () => console.log(installSkills(skillsDir(agent as AgentKind)));

if (process.argv.includes("--skills")) {
  skills();
  process.exit(0);
}

if (agent === "claude") {
  console.log(installClaudeHooks());
  skills();
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
  skills();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
