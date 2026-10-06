import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

/** Path to pi-auth binary. Set to empty string or "none" to disable pi-auth entirely. */
const PI_AUTH = process.env.AGENT_DASH_PI_AUTH ?? "";

/** Path to gh CLI. Defaults to "gh" (expects it in PATH). */
const GH_CLI = process.env.AGENT_DASH_GH_CLI ?? "gh";

/** Where to save the GitHub token for apps that don't use `gh`. */
const GH_TOKEN_FILE = process.env.AGENT_DASH_GH_TOKEN_FILE ?? join(homedir(), ".agent-dash/github-token");

/** Dash source → handler type. Fixed, so the page can never choose what runs. */
export const LOGIN_TARGETS: Record<string, "gh" | "pi-auth"> = { github: "gh", jira: "pi-auth" };

/** What to do by hand when automated login fails. */
const MANUAL: Record<string, string> = {
  jira: "Make a new API token at https://id.atlassian.com/manage-profile/security/api-tokens and put it in ~/pi/secrets/jira/.env.personal.",
  github: "Run `gh auth login` in a terminal, then retry.",
};

function run(cmd: string, args: string[], timeout: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      // A missing binary has no output; its error message says why.
      resolve({ code, output: `${stdout}${stderr}`.trim() || (err && typeof err.code !== "number" ? err.message : "") });
    });
  });
}

const running = new Set<string>();

/**
 * Handle GitHub auth via `gh` CLI.
 * 1. Check if already authenticated with `gh auth status`
 * 2. If so, extract token with `gh auth token` and save it for other tools
 * 3. If not, tell user to run `gh auth login` manually
 */
async function handleGitHub(): Promise<{ code: number; error?: string; output?: string }> {
  // Check auth status first
  const status = await run(GH_CLI, ["auth", "status"], 10_000);
  if (status.code !== 0) {
    return {
      code: 401,
      error: `GitHub CLI not authenticated. ${MANUAL.github}`,
      output: status.output,
    };
  }

  // Get the token and save it for tools that don't use `gh`
  const token = await run(GH_CLI, ["auth", "token"], 10_000);
  if (token.code !== 0) {
    return { code: 200, output: `Authenticated but could not extract token: ${token.output}` };
  }

  try {
    await mkdir(join(homedir(), ".agent-dash"), { recursive: true });
    await writeFile(GH_TOKEN_FILE, token.output.trim(), { mode: 0o600 });
    return { code: 200, output: `GitHub authenticated. Token saved to ${GH_TOKEN_FILE}` };
  } catch (e) {
    return { code: 200, output: `GitHub authenticated. (Token not saved: ${e})` };
  }
}

/** Handle other logins via pi-auth (if configured). */
async function handlePiAuth(target: string): Promise<{ code: number; error?: string; output?: string }> {
  if (!PI_AUTH || PI_AUTH === "none") {
    return { code: 501, error: `pi-auth is not configured. Set AGENT_DASH_PI_AUTH to the path of your pi-auth binary.` };
  }
  const known = await run(PI_AUTH, ["targets"], 10_000);
  if (known.code !== 0) return { code: 500, error: `could not run ${PI_AUTH}: ${known.output || `exit ${known.code}`}` };
  // Tolerate decorated lines such as "  jira (ok)".
  if (!known.output.split("\n").some((l) => l.trim().split(/[\s(]/)[0] === target)) {
    return { code: 501, error: `pi-auth has no ${target} target` };
  }
  // pi-auth stops waiting for a login after 300 s.
  const out = await run(PI_AUTH, ["ensure", target], 320_000);
  if (out.code === 0) return { code: 200, output: out.output };
  return { code: 502, error: out.output.split("\n").at(-1) || `pi-auth exited with ${out.code}`, output: out.output };
}

export async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/login" || req.method !== "POST") return false;
  // Login handlers can open a browser, so the same CSRF guard as /api/focus.
  if (req.headers["x-agent-dash"] !== "1") {
    res.writeHead(403).end();
    return true;
  }
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    return true;
  };
  const source = url.searchParams.get("source") ?? "";
  const handler = Object.hasOwn(LOGIN_TARGETS, source) ? LOGIN_TARGETS[source] : undefined;
  if (!handler) return json(400, { error: `no login to fix for ${source || "(none)"}` });
  if (running.has(source)) return json(409, { error: `a ${source} login is already running` });

  running.add(source);
  try {
    const result = handler === "gh" ? await handleGitHub() : await handlePiAuth(source);
    if (result.code === 200) return json(200, { ok: true, output: result.output });
    return json(result.code, { error: `${result.error} ${MANUAL[source]}`, output: result.output });
  } finally {
    running.delete(source);
  }
}
