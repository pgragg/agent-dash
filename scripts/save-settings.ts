/**
 * Save some settings to agent-dash.config.json, with the Settings page's checks. The setup agent
 * uses it, so a bad value is refused with its reason instead of being written.
 *
 *   echo '{"userName": "Sam", "ticketProjects": ["ABC"]}' | node scripts/save-settings.ts
 *
 * Keys that the JSON leaves out keep their values. Nothing is written when one value is bad.
 */
import { readFileSync } from "node:fs";
import { CONFIG_FILE, CONFIG_READ_ONLY, saveSettingsPatch } from "../server/config.ts";

if (CONFIG_READ_ONLY) {
  console.error(`agent-dash reads ${CONFIG_FILE} from the main checkout. Run this script there.`);
  process.exit(1);
}
let patch: unknown;
try {
  patch = JSON.parse(readFileSync(0, "utf8"));
} catch (err) {
  console.error(`stdin is not JSON: ${(err as Error).message}`);
  process.exit(1);
}
if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
  console.error('stdin must be one JSON object, for example {"userName": "Sam"}');
  process.exit(1);
}
const { settings, errors } = saveSettingsPatch(patch as Record<string, unknown>);
if (Object.keys(errors).length) {
  console.error("Nothing saved. Fix these and run again:");
  for (const [key, error] of Object.entries(errors)) console.error(`  ${key}: ${error}`);
  process.exit(1);
}
console.log(`Saved ${CONFIG_FILE}:`);
console.log(JSON.stringify(settings, null, 2));
console.log("Restart agent-dash to use the new values.");
