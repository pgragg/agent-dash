import { renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type SettingsState, validateSettings } from "../../shared/settings.ts";
import { CONFIG_FILE, config, effectiveSettings, envOverrides, readSettingsFile } from "../config.ts";

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > max) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function settingsState(file = CONFIG_FILE, running = config.settings, env: NodeJS.ProcessEnv = process.env): SettingsState {
  const { settings, exists } = readSettingsFile(file);
  return {
    file,
    exists,
    saved: settings,
    envOverrides: envOverrides(env),
    // Most settings are read once at start (the session index, the caches), so a save waits for a restart.
    restartNeeded: JSON.stringify(effectiveSettings(settings, env)) !== JSON.stringify(running),
  };
}

/**
 * `GET /api/settings`: the config file's values and whether the server runs with them.
 * `POST /api/settings` with the whole settings object: check it, then write the file.
 */
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, file = CONFIG_FILE): Promise<boolean> {
  if (url.pathname !== "/api/settings") return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    return true;
  };
  if (req.method === "GET") return json(200, settingsState(file));
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  // The file names a binary that the server runs (pi-auth), so the same CSRF guard as the other writes.
  if (req.headers["x-agent-dash"] !== "1") return json(403, { error: "missing X-Agent-Dash header" });
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, 32_000)) || "{}");
  } catch {
    return json(400, { error: "the body is not JSON" });
  }
  const { settings, errors } = validateSettings(body);
  if (Object.keys(errors).length) return json(400, { error: "some settings are not valid", errors });
  // A rename is atomic, so a crash never leaves half a file that stops the next start.
  writeFileSync(`${file}.tmp`, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return json(200, settingsState(file));
}
