import { parseEnvironment } from "../shared/sdlc.ts";
import type { SdlcEnvironment, SmoketestOutcome } from "../shared/types.ts";
import type { NewSdlcEvent } from "./summaries/db.ts";

const OUTCOMES: SmoketestOutcome[] = ["passed", "failed", "blocked"];

/** The text fields hold a test's notes and evidence, not its whole log. */
const TEXT_MAX = 20_000;

export interface SdlcEventInput {
  eventType?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  outcome?: unknown;
  testDetails?: unknown;
  testResults?: unknown;
  skippedAt?: unknown;
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
  if (input.outcome !== undefined && input.outcome !== null && !OUTCOMES.includes(input.outcome as SmoketestOutcome)) throw new Error("outcome must be passed, failed or blocked");
  const startedAt = isoOrNull(input.startedAt, "startedAt") ?? now.toISOString();
  const finishedAt = isoOrNull(input.finishedAt, "finishedAt");
  if (finishedAt && finishedAt < startedAt) throw new Error("finishedAt is before startedAt");
  const skippedAt = isoOrNull(input.skippedAt, "skippedAt");
  if (skippedAt && (input.eventType !== "smoketest" || input.outcome)) throw new Error("only a smoketest with no outcome can be skipped");
  return {
    eventType: input.eventType,
    startedAt,
    finishedAt,
    outcome: (input.outcome as NewSdlcEvent["outcome"]) ?? null,
    testDetails: text(input.testDetails, "testDetails"),
    testResults: text(input.testResults, "testResults"),
    skippedAt,
    environments: [...new Set(envs as SdlcEnvironment[])],
    tickets,
  };
}
