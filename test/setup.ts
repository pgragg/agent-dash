// Shared code reads the team settings; a test that never loads server/config.ts gets them here.
// Not by importing config.ts: some tests set env vars that it reads at import.
import { readFileSync } from "node:fs";
import { validateSettings } from "../shared/settings.ts";
import { setTeam } from "../shared/team.ts";

setTeam(validateSettings(JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))).settings);
