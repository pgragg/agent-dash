import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { caddyCommands, cleanHost, cleanPort, rootScript, undoCommands } from "../web/src/localUrl.ts";

test("only a plain host name goes into the commands", () => {
  assert.equal(cleanHost(" https://Agent-Dash.test/x "), "agent-dash.test");
  assert.equal(cleanHost("dash.example.com"), "dash.example.com");
  for (const bad of ["localhost", "a b.test", "x.test;rm -rf ~", "$(id).test", "-a.test", ""]) assert.equal(cleanHost(bad), null, bad);
  assert.equal(cleanPort("7777"), 7777);
  assert.equal(cleanPort("0"), null);
  assert.equal(cleanPort("77a"), null);
});

test("the page's shell is valid sh, and names the host", () => {
  for (const script of [caddyCommands("agent-dash.test", 7777), rootScript("agent-dash.test"), undoCommands("agent-dash.test")]) {
    const r = spawnSync("sh", ["-n"], { input: script });
    assert.equal(r.status, 0, r.stderr.toString());
    assert.match(script, /agent-dash\.test/);
  }
  assert.match(caddyCommands("agent-dash.test", 7788), /reverse_proxy 127\.0\.0\.1:7788/);
});
