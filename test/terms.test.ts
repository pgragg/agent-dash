import assert from "node:assert/strict";
import { test } from "node:test";
import { domainTerm, lintDomain, lookup, readRegistry } from "../shared/terms.ts";

const registry = {
  contexts: { viewer: { name: "Docs-viewer RBAC" } },
  services: { fdr: { name: "FDR", stores: { pg: "FDR Postgres" } } },
  terms: {
    docs_ledger_segment_details: { kind: "rec", service: "fdr", store: "pg", context: "viewer", about: "Nav metadata." },
    matchRoles: { kind: "fn", about: "Decides access." },
    R1: { kind: "rule", name: "A child narrows its parent's access", about: "x" },
  },
};
const doc = (body: string) => "```domain\n" + JSON.stringify(registry) + "\n```\n" + body;

test("a prefixed code span is a domain mark, and other code is not", () => {
  assert.deepEqual(domainTerm("rec:UserRolesPerResource.role"), { kind: "rec", name: "UserRolesPerResource.role" });
  assert.deepEqual(domainTerm("ctx:viewer"), { kind: "ctx", name: "viewer" });
  for (const plain of ["matchRoles", "rec: x", "fn:", "http://x", "dbx:y", "src/fn:1"]) assert.equal(domainTerm(plain), null, plain);
});

test("a column falls back to its table's entry", () => {
  const r = readRegistry(doc("")).registry!;
  assert.equal(lookup(r, "docs_ledger_segment_details.viewers")?.base, "docs_ledger_segment_details");
  assert.equal(lookup(r, "nope.viewers"), null);
});

test("lint passes a clean document, and names each problem", () => {
  assert.deepEqual(lintDomain(doc("## A `ctx:viewer`\n`rec:docs_ledger_segment_details.viewers` `fn:matchRoles` `rule:R1`")), []);
  const issues = lintDomain(doc("`obj:matchRoles` `fn:missing` `matchRoles`\n```\n`fn:inFence`\n```")).map((i) => i.message);
  assert.ok(issues.some((m) => m.includes("registered as fn, not obj")));
  assert.ok(issues.some((m) => m.includes("`fn:missing` is not in the registry")));
  assert.ok(issues.some((m) => m.includes("no mark")));
  assert.ok(!issues.some((m) => m.includes("inFence")));
  assert.ok(issues.some((m) => m.includes("context viewer is never marked")));
  assert.match(lintDomain("no fence")[0].message, /no domain fence/);
});
