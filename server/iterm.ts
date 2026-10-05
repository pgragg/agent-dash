import { execFile } from "node:child_process";

/** The uuid comes in as argv, so nothing from the request is spliced into the script. */
const FOCUS_SCRIPT = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if unique id of s is (item 1 of argv) then
            tell w to select
            tell t to select
            tell s to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

export type FocusResult = "ok" | "missing" | "not_authorized" | "error";

export function focusItermSession(uuid: string): Promise<{ result: FocusResult; detail?: string }> {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", FOCUS_SCRIPT, uuid], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ result: stdout.trim() === "ok" ? "ok" : "missing" });
      // -1743: macOS has not allowed the app that started the server to control iTerm2.
      if (stderr.includes("-1743")) return resolve({ result: "not_authorized", detail: stderr.trim() });
      resolve({ result: "error", detail: stderr.trim() || err.message });
    });
  });
}

/** Opens a new tab in the front window (or a new window) and types the command into its shell. */
const NEW_TAB_SCRIPT = `on run argv
  tell application "iTerm2"
    activate
    if (count of windows) is 0 then
      set w to (create window with default profile)
    else
      set w to current window
      tell w to create tab with default profile
    end if
    tell current session of w to write text (item 1 of argv)
  end tell
  return "ok"
end run`;

/**
 * Run a command in a new iTerm2 tab. It goes through your interactive shell, so shell aliases and
 * PATH apply, as when you type it yourself. The command arrives as argv, never spliced into the script.
 */
export function runInNewItermTab(command: string): Promise<{ result: FocusResult; detail?: string }> {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", NEW_TAB_SCRIPT, command], { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (!err) return resolve({ result: "ok" });
      if (stderr.includes("-1743")) return resolve({ result: "not_authorized", detail: stderr.trim() });
      resolve({ result: "error", detail: stderr.trim() || err.message });
    });
  });
}

/** The command a dash-started agent runs: pi in `dir`, named, with the context file and first message. */
export function piCommand(dir: string, name: string, contextFile: string, messageFile: string, sessionId: string): string {
  return `cd ${shellQuote(dir)} && pi --session-id ${shellQuote(sessionId)} --name ${shellQuote(name)} @${shellQuote(contextFile)} "$(cat ${shellQuote(messageFile)})"`;
}

/** Single-quote a value for a POSIX shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
