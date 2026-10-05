import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A stub pi-auth, so the test never runs the real one or opens Chrome.
const dir = mkdtempSync(join(tmpdir(), "agent-dash-login-"));
const stub = join(dir, "pi-auth");
const calls = join(dir, "calls.log");
writeFileSync(
  stub,
  `#!/bin/sh
echo "$@" >> ${calls}
case "$1" in
targets) printf '  argo-beta\\njira (api token)\\n' ;;
ensure) [ "$2" = jira ] && echo "ok       jira (logged in)" && exit 0; echo "EXPIRED  $2"; exit 1 ;;
esac
`,
);
chmodSync(stub, 0o755);
writeFileSync(calls, "");
process.env.AGENT_DASH_PI_AUTH = stub;
const { handle } = await import("../server/routes/login.ts");

async function call(source: string, headers: Record<string, string> = { "x-agent-dash": "1" }) {
  let code = 0;
  let body = "";
  const res = {
    writeHead(c: number) {
      code = c;
      return this;
    },
    end(b?: string) {
      body = b ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  const handled = await handle({ method: "POST", headers } as IncomingMessage, res, new URL(`http://x/api/login?source=${encodeURIComponent(source)}`));
  return { handled, code, body: body ? JSON.parse(body) : null };
}

test("only the fixed sources run pi-auth, and only with the guard header", async () => {
  for (const s of ["evil", "__proto__", "constructor", "sessions", "jira;rm -rf ~", ""]) assert.equal((await call(s)).code, 400, s);
  assert.equal((await call("jira", {})).code, 403);
  assert.equal(readFileSync(calls, "utf8").includes("ensure"), false);
});

test("a known target runs pi-auth ensure with that target", async () => {
  const out = await call("jira");
  assert.equal(out.code, 200);
  assert.match(readFileSync(calls, "utf8"), /^ensure jira$/m);
});

test("a target that pi-auth does not list gets the manual hint, without ensure", async () => {
  const out = await call("github");
  assert.equal(out.code, 501);
  assert.match(out.body.error, /pi-auth has no github target.*gh auth login/);
  assert.doesNotMatch(readFileSync(calls, "utf8"), /ensure github/);
});

test("other paths and methods are not this route", async () => {
  const res = {} as ServerResponse;
  assert.equal(await handle({ method: "GET", headers: {} } as IncomingMessage, res, new URL("http://x/api/login")), false);
  assert.equal(await handle({ method: "POST", headers: {} } as IncomingMessage, res, new URL("http://x/api/other")), false);
});
