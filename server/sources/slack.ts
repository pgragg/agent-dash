import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SourceHealth } from "../../shared/types.ts";

const POST_SCRIPT = new URL("../../scripts/slack-post.ts", import.meta.url).pathname;

/** One half of the Slack login: `off` when it is not set up. */
export type Half = { ok: true } | { ok: false; error: string } | { off: string };

/**
 * The saved agent-browser login that summaries search with. Only the file is read: opening Slack
 * with it from a headless browser to test it can get the session revoked, so a login that Slack
 * revoked before its cookie expires shows only through a draft's Gaps line.
 */
export function searchLogin(stateFile: string, now = Date.now()): Half & { savedAt?: string } {
  if (!stateFile) return { off: "no Slack login state is set" };
  let text: string;
  let savedAt: string;
  try {
    text = readFileSync(stateFile, "utf8");
    savedAt = statSync(stateFile).mtime.toISOString();
  } catch {
    return { ok: false, error: `no saved Slack login at ${stateFile}` };
  }
  let cookies: { name?: string; domain?: string; expires?: number }[] = [];
  try {
    cookies = JSON.parse(text).cookies ?? [];
  } catch {
    return { ok: false, error: `${stateFile} is not an agent-browser state file`, savedAt };
  }
  // `d` is Slack's session cookie; -1 is a browser-session cookie with no end date.
  const d = cookies.find((c) => c.name === "d" && /(^|\.)slack\.com$/.test(c.domain ?? ""));
  if (!d) return { ok: false, error: `the saved Slack login has no session cookie`, savedAt };
  if (typeof d.expires === "number" && d.expires > 0 && d.expires * 1000 < now) return { ok: false, error: "the saved Slack login expired", savedAt };
  return { ok: true, savedAt };
}

/** True when a next-steps summary's Gaps line says that the Slack login failed. */
export function slackLoginGap(summary: string): boolean {
  const gaps = summary.match(/\bgaps\b[*: \t]*(.*)/i)?.[1] ?? "";
  return /slack/i.test(gaps) && /expired|log(ged)?[- ]?(in|out)|sign(ed)?[- ]?(in|out)/i.test(gaps);
}

/** Can the pi-mcp-adapter `slack` grant post? Runs `slack-post.ts --check`, which posts nothing. */
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

/**
 * One health for both Slack logins. A draft's login gap counts until a newer login replaces it:
 * the state file saved again, or a Fix Slack login that worked.
 */
export function slackHealth(search: Half & { savedAt?: string }, post: Half, gap: { at: string; ticket: string } | null, fixedAt: string | null): SourceHealth {
  const errors: string[] = [];
  if ("off" in search && "off" in post) return { ok: true, off: true, label: "Slack" };
  if (!("off" in search)) {
    if (!search.ok) errors.push(`Slack search: ${search.error}`);
    else if (gap && gap.at > (search.savedAt ?? "") && gap.at > (fixedAt ?? "")) errors.push(`Slack search: the ${gap.ticket} next-steps draft at ${gap.at} says the Slack login expired`);
  }
  if (!("off" in post) && !post.ok) errors.push(`Post to Slack: ${post.error}`);
  return errors.length ? { ok: false, label: "Slack", error: errors.join(" · ") } : { ok: true, label: "Slack" };
}

/**
 * The manual steps for only the Slack halves that `slackHealth` says failed. No login tool can
 * refresh the search login: it must come from the user's own Chrome, because Slack revokes a
 * session whose cookies a headless browser copied.
 */
export function slackFixSteps(health: SourceHealth, slack: { stateFile: string; reloginCommand: string }): string {
  const failed = (health.error ?? "").split(" · ");
  const steps: string[] = [];
  if (failed.some((e) => e.startsWith("Slack search:"))) {
    const readme = join(dirname(slack.stateFile), "README.md");
    steps.push(
      "For Slack search, sign in to Slack in Chrome and turn on chrome://inspect/#remote-debugging. Then save that login, with only its *.slack.com cookies: " +
        `\`umask 077; tmp=$(mktemp); agent-browser --session probe --auto-connect state save "$tmp" && jq '{cookies: [.cookies[] | select(.domain|test("slack\\\\.com$"))], origins: []}' "$tmp" > "${slack.stateFile}"; rm -f "$tmp"\`.` +
        (existsSync(readme) ? ` More in ${readme}.` : ""),
    );
  }
  if (failed.some((e) => e.startsWith("Post to Slack:"))) {
    steps.push(slack.reloginCommand ? `For Post to Slack, run \`${slack.reloginCommand}\` in a terminal and allow the grant.` : "For Post to Slack, sign in to the slack server of pi-mcp-adapter again, or set the Slack sign-in command on the Settings page.");
  }
  return steps.join(" ");
}
