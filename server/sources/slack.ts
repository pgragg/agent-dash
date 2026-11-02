import { execFile } from "node:child_process";
import type { SourceHealth } from "../../shared/types.ts";

const POST_SCRIPT = new URL("../../scripts/slack-post.ts", import.meta.url).pathname;

/** The Slack sign-in: `off` when it is not set up. */
export type Half = { ok: true } | { ok: false; error: string } | { off: string };

/**
 * Can the pi-mcp-adapter `slack` grant search and post? Runs `slack-post.ts --check`, which
 * connects and posts nothing. Slack search uses the same grant, so this checks both.
 */
export function postLogin(): Promise<Half> {
  return new Promise((resolve) => {
    execFile(process.execPath, [POST_SCRIPT, "--check"], { timeout: 45_000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: stderr.trim().split("\n").at(-1) || err.message });
      try {
        const out = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as { ok?: boolean; off?: string };
        resolve(out.off ? { off: out.off } : { ok: true });
      } catch {
        resolve({ ok: false, error: `unexpected answer from slack-post.ts --check: ${stdout.slice(0, 200)}` });
      }
    });
  });
}

/** The top bar's Slack health, from the one Slack sign-in. */
export function slackHealth(login: Half): SourceHealth {
  if ("off" in login) return { ok: true, off: true, label: "Slack" };
  return login.ok ? { ok: true, label: "Slack" } : { ok: false, label: "Slack", error: `Slack: ${login.error}` };
}

/** The manual step to sign in to Slack again: the OAuth consent needs the user's click. */
export function slackFixSteps(slack: { reloginCommand: string }): string {
  return slack.reloginCommand ? `Run \`${slack.reloginCommand}\` in a terminal and allow the grant.` : "Sign in to the slack server of pi-mcp-adapter again, or set the Slack sign-in command on the Settings page.";
}
