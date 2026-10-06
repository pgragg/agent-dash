import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Stub binaries so the test never runs real auth or opens a browser.
const dir = mkdtempSync(join(tmpdir(), "agent-dash-login-"));
const piAuthStub = join(dir, "pi-auth");
const ghStub = join(dir, "gh");
const piAuthCalls = join(dir, "pi-auth-calls.log");
const ghCalls = join(dir, "gh-calls.log");

writeFileSync(
  piAuthStub,
  `#!/bin/sh
echo "$@" >> ${piAuthCalls}
case "$1" in
targets) printf '  argo-beta\\njira (api token)\\n' ;;
ensure) [ "$2" = jira ] && echo "ok       jira (logged in)" && exit 0; echo "EXPIRED  $2"; exit 1 ;;
esac
`,
);
chmodSync(piAuthStub, 0o755);
writeFileSync(piAuthCalls, "");

writeFileSync(
  ghStub,
  `#!/bin/sh
echo "$@" >> ${ghCalls}
case "$1 $2" in
"auth status") echo "Logged in to github.com as user" && exit 0 ;;
"auth token") echo "gho_test_token_12345" && exit 0 ;;
esac
exit 1
`,
);
chmodSync(ghStub, 0o755);
writeFileSync(ghCalls, "");

process.env.AGENT_DASH_PI_AUTH = piAuthStub;
process.env.AGENT_DASH_GH_CLI = ghStub;
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

test("only the fixed sources run auth handlers, and only with the guard header", async () => {
  for (const s of ["evil", "__proto__", "constructor", "sessions", "jira;rm -rf ~", ""]) assert.equal((await call(s)).code, 400, s);
  assert.equal((await call("jira", {})).code, 403);
  assert.equal(readFileSync(piAuthCalls, "utf8").includes("ensure"), false);
  assert.equal(readFileSync(ghCalls, "utf8").includes("auth"), false);
});

test("jira runs pi-auth ensure", async () => {
  const out = await call("jira");
  assert.equal(out.code, 200);
  assert.match(readFileSync(piAuthCalls, "utf8"), /^ensure jira$/m);
});

test("github checks auth status and extracts token", async () => {
  const out = await call("github");
  assert.equal(out.code, 200);
  const calls = readFileSync(ghCalls, "utf8");
  assert.match(calls, /^auth status$/m);
  assert.match(calls, /^auth token$/m);
});

test("other paths and methods are not this route", async () => {
  const res = {} as ServerResponse;
  assert.equal(await handle({ method: "GET", headers: {} } as IncomingMessage, res, new URL("http://x/api/login")), false);
  assert.equal(await handle({ method: "POST", headers: {} } as IncomingMessage, res, new URL("http://x/api/other")), false);
});
