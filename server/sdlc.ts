import { parseEnvironment } from "../shared/sdlc.ts";
import type { SdlcEnvironment } from "../shared/types.ts";
import type { NewSdlcEvent, SdlcFinish } from "./summaries/db.ts";

/** The text fields hold a test's notes and evidence, not its whole log. */
const TEXT_MAX = 20_000;

export interface SdlcEventInput {
  eventType?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  outcome?: unknown;
  testDetails?: unknown;
  testResults?: unknown;
  environments?: unknown;
  tickets?: unknown;
}

function isoOrNull(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new Error(`${field} is not a date: ${String(v)}`);
  return new Date(v).toISOString();
}

function text(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`${field} must be text`);
  if (v.length > TEXT_MAX) throw new Error(`${field} is longer than ${TEXT_MAX} characters`);
  return v.trim() || null;
}

/** Checks a new event from the page or the script. Throws the first problem it finds. */
export function validateSdlcEvent(input: SdlcEventInput, ticketPattern: RegExp, now = new Date()): NewSdlcEvent {
  if (input.eventType !== "smoketest" && input.eventType !== "deploy") throw new Error("eventType must be smoketest or deploy");
  const tickets = Array.isArray(input.tickets) ? [...new Set(input.tickets.map(String))] : [];
  const keyRe = new RegExp(`^${ticketPattern.source}$`);
  if (!tickets.length) throw new Error("name at least one ticket");
  for (const t of tickets) if (!keyRe.test(t)) throw new Error(`not a ticket key: ${t}`);
  const envs = Array.isArray(input.environments) ? input.environments.map((e) => parseEnvironment(String(e))) : [];
  if (!envs.length) throw new Error("name at least one environment under test");
  if (envs.includes(null)) throw new Error(`unknown environment in ${JSON.stringify(input.environments)}`);
  if (input.outcome !== undefined && input.outcome !== null && input.outcome !== "passed" && input.outcome !== "failed") throw new Error("outcome must be passed or failed");
  const startedAt = isoOrNull(input.startedAt, "startedAt") ?? now.toISOString();
  const finishedAt = isoOrNull(input.finishedAt, "finishedAt");
  if (finishedAt && finishedAt < startedAt) throw new Error("finishedAt is before startedAt");
  return {
    eventType: input.eventType,
    startedAt,
    finishedAt,
    outcome: (input.outcome as NewSdlcEvent["outcome"]) ?? null,
    testDetails: text(input.testDetails, "testDetails"),
    testResults: text(input.testResults, "testResults"),
    environments: [...new Set(envs as SdlcEnvironment[])],
    tickets,
  };
}

/** Checks the result that a smoketest agent records on the event that agent-dash started for it. */
export function validateSdlcFinish(input: { finishedAt?: unknown; outcome?: unknown; testDetails?: unknown; testResults?: unknown }, startedAt: string, now = new Date()): SdlcFinish {
  if (input.outcome !== "passed" && input.outcome !== "failed") throw new Error("outcome must be passed or failed");
  const finishedAt = isoOrNull(input.finishedAt, "finishedAt") ?? now.toISOString();
  if (finishedAt < startedAt) throw new Error("finishedAt is before startedAt");
  return { finishedAt, outcome: input.outcome, testDetails: text(input.testDetails, "testDetails"), testResults: text(input.testResults, "testResults") };
}
