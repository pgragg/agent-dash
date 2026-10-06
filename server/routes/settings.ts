import type { IncomingMessage, ServerResponse } from "node:http";
import { type SettingsState, validateSettings } from "../../shared/settings.ts";
import { CONFIG_FILE, CONFIG_READ_ONLY, config, effectiveSettings, envOverrides, readSettingsFile, writeSettingsFile } from "../config.ts";

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

export function settingsState(file = CONFIG_FILE, readOnly = CONFIG_READ_ONLY, running = config.settings, env: NodeJS.ProcessEnv = process.env): SettingsState {
  const { settings, exists } = readSettingsFile(file);
  return {
    file,
    exists,
    readOnly,
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
export async function handle(req: IncomingMessage, res: ServerResponse, url: URL, file = CONFIG_FILE, readOnly = CONFIG_READ_ONLY): Promise<boolean> {
  if (url.pathname !== "/api/settings") return false;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    return true;
  };
  if (req.method === "GET") return json(200, settingsState(file, readOnly));
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  // The file names a binary that the server runs (pi-auth), so the same CSRF guard as the other writes.
  if (req.headers["x-agent-dash"] !== "1") return json(403, { error: "missing X-Agent-Dash header" });
  if (readOnly) return json(409, { error: `this server reads ${file} from the main checkout; change it from the main checkout's server` });
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, 32_000)) || "{}");
  } catch {
    return json(400, { error: "the body is not JSON" });
  }
  // The page's form does not hold the ticket providers list, so a save keeps the file's.
  const kept = { ticketProviders: readSettingsFile(file).settings.ticketProviders };
  const { settings, errors } = validateSettings({ ...kept, ...(body && typeof body === "object" ? body : {}) });
  if (Object.keys(errors).length) return json(400, { error: "some settings are not valid", errors });
  writeSettingsFile(settings, file);
  return json(200, settingsState(file, readOnly));
}
