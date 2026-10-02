import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHandoff, HANDOFF_END, HANDOFF_START, stepMessage } from "../server/handoff.ts";
import { parseSession } from "../server/sources/sessions.ts";
import type { TicketGroup } from "../shared/types.ts";
import { header, jsonl, NOW, pr, reply, run, ticket, user } from "./helpers.ts";

const group = (): TicketGroup => ({
  ticket: ticket({ key: "FSDK-5", summary: "Fix the emails", status: "In Progress" }),
  runs: [
    run({ sessionId: "old", name: "Dropped approach", status: "finished", lastMessage: "OLD MESSAGE", userMessageCount: 4 }),
    run({ sessionId: "live", name: "Current fix", status: "awaiting_input", lastMessage: "PR is up; want me to ping Arie?", userMessageCount: 7 }),
  ],
  prs: [pr({ url: "https://github.com/o/r/pull/9", title: "fix emails", reviewDecision: "REVIEW_REQUIRED", tickets: ["FSDK-5"] })],
  threads: { old: { id: 1, ticket: "FSDK-5", sessionId: "old", status: "resolved", reason: "wrong direction", createdAt: "2026-10-02T09:00:00.000Z" } },
});

test("the handoff carries notes, drafted next steps with their date, PRs, live messages and the run history", () => {
  const ctx = buildHandoff({
    group: group(),
    notes: [{ id: 1, ticket: "FSDK-5", createdAt: "2026-10-02T10:00:00.000Z", body: "Arie reviews on Monday" }],
    summary: { latest: { id: 2, ticket: "FSDK-5", status: "done", requestedAt: "2026-10-02T10:30:00.000Z", generatedAt: "2026-10-02T10:32:00.000Z", summary: "**State:** in review", error: null, steps: [] }, lastDone: null },
    now: new Date(NOW),
  });
  assert.ok(ctx.startsWith(HANDOFF_START("FSDK-5")) && ctx.endsWith(HANDOFF_END));
  assert.match(ctx, /\[2026-10-02T10:00:00.000Z\] Arie reviews on Monday/);
  assert.match(ctx, /Drafted 2026-10-02T10:32:00.000Z/);
  assert.match(ctx, /\*\*State:\*\* in review/);
  assert.match(ctx, /pull\/9 — fix emails \(open, CI success, REVIEW_REQUIRED/);
  // The live, relevant agent's message is in; the resolved one's is not.
  assert.match(ctx, /PR is up; want me to ping Arie\?/);
  assert.doesNotMatch(ctx, /OLD MESSAGE/);
  // Every run is in the history, with prompts, status and resolution.
  assert.match(ctx, /Dropped approach · started .* · 4 prompts · finished · resolved by Piper 2026-10-02T09:00:00.000Z: wrong direction/);
  assert.match(ctx, /Current fix · started .* · 7 prompts · waiting for input · relevant/);
});

test("a run started from a handoff links to its ticket, not to the tickets the context mentions", () => {
  const ctx = `${HANDOFF_START("FSDK-5")}\nNotes mention FSDK-77 and FSDK-88, and https://github.com/o/r/pull/3\n${HANDOFF_END}`;
  const first = `<file name="/h/FSDK-5.md">\n${ctx}\n</file>\nPing the reviewer`;
  const s = parseSession(jsonl(header(), user(first), reply("ok")), "/f.jsonl", new Date(NOW), /\b(?:FSDK|EFSUP)-\d+\b/g)!;
  assert.deepEqual(s.tickets, ["FSDK-5"]);
  assert.deepEqual(s.mentionedPrs, []);
  assert.equal(s.firstPrompt, "[agent-dash context for FSDK-5] Ping the reviewer");
});

test("an agent started on a step gets the step after an instruction to check it first", () => {
  const msg = stepMessage("FSDK-5", "Piper: ping Arie for review.");
  assert.match(msg, /^Do this next step on FSDK-5\./);
  assert.ok(msg.endsWith("\n\nPiper: ping Arie for review."));
});
