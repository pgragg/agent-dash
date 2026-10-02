/**
 * Symlink the status extension into pi's global extension folder.
 * A symlink, not a copy, so a `git pull` here also updates the extension.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
