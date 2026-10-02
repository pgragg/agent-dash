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
