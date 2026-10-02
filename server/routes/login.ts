import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_AUTH = process.env.AGENT_DASH_PI_AUTH ?? join(homedir(), "pi/auth/pi-auth");

/** Dash source → pi-auth target. Fixed, so the page can never choose what runs. */
export const LOGIN_TARGETS: Record<string, string> = { jira: "jira", github: "github" };

/** What to do by hand when pi-auth cannot refresh the login. */
const MANUAL: Record<string, string> = {
  jira: "Make a new API token at https://id.atlassian.com/manage-profile/security/api-tokens and put it in ~/pi/secrets/jira/.env.personal.",
  github: "Run `gh auth login --web` in a terminal.",
};

function run(args: string[], timeout: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(PI_AUTH, args, { timeout, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

const running = new Set<string>();

export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/login" || req.method !== "POST") return false;
  // pi-auth opens Chrome, so the same CSRF guard as /api/focus.
  if (req.headers["x-agent-dash"] !== "1") {
    res.writeHead(403).end();
    return true;
  }
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    return true;
  };
  const source = url.searchParams.get("source") ?? "";
  const target = Object.hasOwn(LOGIN_TARGETS, source) ? LOGIN_TARGETS[source] : undefined;
  if (!target) return json(400, { error: `no login to fix for ${source || "(none)"}` });
  if (running.has(target)) return json(409, { error: `a ${source} login is already running` });

  running.add(target);
  try {
    const known = await run(["targets"], 10_000);
    if (!known.output.split("\n").includes(target)) return json(501, { error: `pi-auth has no ${target} target. ${MANUAL[source]}` });
    // pi-auth stops waiting for a login after 300 s.
    const out = await run(["ensure", target], 320_000);
    if (out.code === 0) return json(200, { ok: true, output: out.output });
    return json(502, { error: `${out.output.split("\n").at(-1) || `pi-auth exited with ${out.code}`} ${MANUAL[source]}`, output: out.output });
  } finally {
    running.delete(target);
  }
}
