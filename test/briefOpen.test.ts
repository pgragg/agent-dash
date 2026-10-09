import assert from "node:assert/strict";
import { test } from "node:test";
import { isBriefOpen, setBriefOpen } from "../web/src/briefOpen.ts";

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test("a brief starts closed, and the workspace remembers open or closed per ticket", () => {
  const s = store();
  assert.equal(isBriefOpen(s, "FSDK-1"), false);
  setBriefOpen(s, "FSDK-1", true);
  assert.equal(isBriefOpen(s, "FSDK-1"), true);
  assert.equal(isBriefOpen(s, "FSDK-2"), false);
  setBriefOpen(s, "FSDK-1", false);
  assert.equal(isBriefOpen(s, "FSDK-1"), false);
});

test("a damaged value reads as every brief closed", () => {
  const s = store();
  s.setItem("agent-dash:brief-open", "{ not json");
  assert.equal(isBriefOpen(s, "FSDK-1"), false);
  setBriefOpen(s, "FSDK-1", true);
  assert.equal(isBriefOpen(s, "FSDK-1"), true);
});
