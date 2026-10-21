import assert from "node:assert/strict";
import { test } from "node:test";
import { domainTerm } from "../shared/terms.ts";

test("a prefixed code span is a domain term, and other code is not", () => {
  assert.deepEqual(domainTerm("db:UserRolesPerResource.role"), { kind: "db", name: "UserRolesPerResource.role" });
  assert.deepEqual(domainTerm("fn:matchRoles"), { kind: "fn", name: "matchRoles" });
  assert.deepEqual(domainTerm("obj:FernUser.roles"), { kind: "obj", name: "FernUser.roles" });
  for (const plain of ["matchRoles", "db: x", "db:", "http://x", "dbx:y", "src/db:1"]) assert.equal(domainTerm(plain), null, plain);
});
