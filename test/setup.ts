// Shared code reads the team settings; a test that never loads server/config.ts gets them here.
// Not by importing config.ts: some tests set env vars that it reads at import.
import { readFileSync } from "node:fs";
import { validateSettings } from "../shared/settings.ts";
import { setTeam } from "../shared/team.ts";

setTeam(validateSettings(JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))).settings);

// The tests make many throwaway repos. A global core.fsmonitor would start a daemon in each one
// that outlives the test, and macOS refuses new file watchers once 1024 of them are running.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
process.env.GIT_CONFIG_VALUE_0 = "false";
