import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compress } from "../server/compress.ts";
import { readDiskCache, writeDiskCache } from "../server/diskCache.ts";
import { findRun, forPage } from "../server/model.ts";
import { type Dashboard, PARKED_ASK_CHARS, type ParkedRun } from "../shared/types.ts";
import { run, ticket } from "./helpers.ts";

const long = "x".repeat(5000);
const parked = (over: Partial<ParkedRun> = {}): ParkedRun => ({ sessionId: "p1", ticket: null, name: null, cwd: "/r", reason: "stale", parkedAt: "2026-10-02T00:00:00Z", needs: null, latest: null, lastMessage: long + "END", ...over });

function dashboard(): Dashboard {
  const done = run({ sessionId: "done", status: "finished", lastMessage: "done text" });
  const live = run({ sessionId: "live", status: "awaiting_input", lastMessage: "live text" });
  return {
    generatedAt: "",
    attention: [{ ticketKey: null, sessionId: "done", since: "", updatedAt: "", name: "", kind: "awaiting_input", score: 1, status: "", reason: "", ticketUrl: null, run: done }],
    myTickets: [{ ticket: ticket(), runs: [done, live], suggested: [run({ sessionId: "sug", lastMessage: "suggested text" })], prs: [] }],
    otherTickets: [{ ticket: ticket({ key: "FSDK-2" }), runs: [run({ sessionId: "empty", lastMessage: "" })], prs: [] }],
    unlinkedRuns: [run({ sessionId: "loose", lastMessage: "loose text" })],
    prs: [],
    counts: { working: 0, awaiting_input: 1, finished: 3 },
    summaries: {},
    notes: {},
    snoozedUntil: {},
    starred: [],
    untilChange: {},
    diagrams: [],
    documents: [],
    sdlcEvents: {},
    reviewDrafts: {},
    conversationSummaries: {},
    reviewRequests: {},
    parked: [parked()],
    sources: {},
    extensionInstalled: false,
  } as unknown as Dashboard;
}

test("the page gets no finished run's last message, only a mark that the server has one", () => {
  const page = forPage(dashboard());
  const [done, live] = page.myTickets[0].runs;
  assert.deepEqual([done.lastMessage, done.lastMessageCut], ["", true]);
  assert.deepEqual([live.lastMessage, live.lastMessageCut], ["live text", undefined]);
  assert.equal(page.myTickets[0].suggested![0].lastMessageCut, true);
  assert.equal(page.unlinkedRuns[0].lastMessage, "");
  assert.equal(page.attention[0].run!.lastMessage, "");
  // A run with no message has nothing to load.
  assert.equal(page.otherTickets[0].runs[0].lastMessageCut, undefined);
});

test("the page gets only the end of a parked run's last message, which is all that it shows", () => {
  const p = forPage(dashboard()).parked[0];
  assert.equal(p.lastMessage.length, PARKED_ASK_CHARS);
  assert.ok(p.lastMessage.endsWith("END"));
});

test("forPage leaves the server's own dashboard whole", () => {
  const d = dashboard();
  forPage(d);
  assert.equal(d.myTickets[0].runs[0].lastMessage, "done text");
  assert.equal(d.parked[0].lastMessage.length, long.length + 3);
});

test("findRun gives the whole message of a run on the board, also a suggested one", () => {
  const d = dashboard();
  assert.equal(findRun(d, "done")?.lastMessage, "done text");
  assert.equal(findRun(d, "sug")?.lastMessage, "suggested text");
  assert.equal(findRun(d, "loose")?.lastMessage, "loose text");
  assert.equal(findRun(d, "nope"), undefined);
});

test("compress picks brotli, then gzip, then none, from Accept-Encoding", async () => {
  const body = JSON.stringify({ a: "y".repeat(10_000) });
  const br = await compress(body, "gzip, deflate, br, zstd");
  assert.equal(br.encoding, "br");
  assert.equal(brotliDecompressSync(br.data).toString(), body);
  const gz = await compress(body, "gzip, deflate");
  assert.equal(gz.encoding, "gzip");
  assert.equal(gunzipSync(gz.data).toString(), body);
  assert.deepEqual(await compress(body, ""), { encoding: null, data: body });
});

test("the disk cache gives back what it saved, and nothing for a missing or broken file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-cache-"));
  const file = join(dir, "sub", "prs.json");
  assert.equal(readDiskCache(file), null);
  await writeDiskCache(file, [{ n: 1 }], "2026-10-02T12:00:00.000Z");
  assert.deepEqual(readDiskCache(file), { value: [{ n: 1 }], fetchedAt: "2026-10-02T12:00:00.000Z" });
  writeFileSync(file, "{not json");
  assert.equal(readDiskCache(file), null);
});
