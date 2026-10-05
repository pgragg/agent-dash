import { executeMessage, parseEnvironment } from "../shared/sdlc.ts";
import type { SdlcEnvironment, SdlcEvent, SmoketestOutcome } from "../shared/types.ts";
import * as db from "./summaries/db.ts";
import type { NewSdlcEvent, SdlcFinish, SdlcPlan } from "./summaries/db.ts";

const OUTCOMES: SmoketestOutcome[] = ["passed", "failed", "blocked"];

/** The text fields hold a test's notes and evidence, not its whole log. */
const TEXT_MAX = 20_000;
/** The summary is one line on the collapsed row; the details and results hold the rest. */
const SUMMARY_MAX = 200;

export interface SdlcEventInput {
  eventType?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  outcome?: unknown;
  testDetails?: unknown;
  testResults?: unknown;
  skippedAt?: unknown;
  summary?: unknown;
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

function summaryText(v: unknown): string | null {
  const s = text(v, "summary")?.replace(/\s+/g, " ") ?? null;
  if (s && s.length > SUMMARY_MAX) throw new Error(`summary is longer than ${SUMMARY_MAX} characters`);
  return s;
}

/** Checks a new event from the page or the script. Throws the first problem it finds. */
export function validateSdlcEvent(input: SdlcEventInput, ticketPattern: RegExp, now = new Date()): NewSdlcEvent {
  // A plan is made only by the server, with the agent that writes it.
  if (input.eventType !== "smoketest_execution" && input.eventType !== "deploy") throw new Error("eventType must be smoketest_execution or deploy");
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
  if (skippedAt && (input.eventType !== "smoketest_execution" || input.outcome)) throw new Error("only a smoketest with no outcome can be skipped");
  return {
    eventType: input.eventType,
    startedAt,
    finishedAt,
    outcome: (input.outcome as NewSdlcEvent["outcome"]) ?? null,
    testDetails: text(input.testDetails, "testDetails"),
    testResults: text(input.testResults, "testResults"),
    skippedAt,
    summary: summaryText(input.summary),
    environments: [...new Set(envs as SdlcEnvironment[])],
    tickets,
  };
}

/** An agent result must not end a smoketest before it started. */
export function validateSdlcFinish(input: { finishedAt?: unknown; outcome?: unknown; testDetails?: unknown; testResults?: unknown; summary?: unknown }, startedAt: string, now = new Date()): SdlcFinish {
  if (!OUTCOMES.includes(input.outcome as SmoketestOutcome)) throw new Error("outcome must be passed, failed or blocked");
  const finishedAt = isoOrNull(input.finishedAt, "finishedAt") ?? now.toISOString();
  if (finishedAt < startedAt) throw new Error("finishedAt is before startedAt");
  return { finishedAt, outcome: input.outcome as SmoketestOutcome, testDetails: text(input.testDetails, "testDetails"), testResults: text(input.testResults, "testResults"), summary: summaryText(input.summary) };
}

/** "none" (any case) or an empty text: the test changes no Beta or Prod state. */
export function validateSdlcPlan(input: { plan?: unknown; stateChanges?: unknown }, now = new Date()): SdlcPlan {
  const plan = text(input.plan, "plan");
  if (!plan) throw new Error("the plan is empty");
  const changes = text(input.stateChanges, "stateChanges");
  if (changes === null && input.stateChanges === undefined) throw new Error("say which Beta or Prod state the test changes, or none");
  return { plan, stateChanges: changes && changes.toLowerCase() !== "none" ? changes : null, plannedAt: now.toISOString() };
}

/** Saves the running execution of an accepted plan, and returns it with the message that starts it. */
export function startExecution(plan: SdlcEvent, sessionId: string | null, script: string): { execution: SdlcEvent; message: string } {
  if (plan.eventType !== "smoketest_plan" || !plan.confirmedAt) throw new Error(`SDLC event ${plan.id} is not an accepted plan`);
  const execution = db.addSdlcEvent({ eventType: "smoketest_execution", startedAt: new Date().toISOString(), environments: plan.environments, tickets: plan.tickets, sessionId, planId: plan.id });
  return { execution, message: executeMessage(plan.tickets[0], plan.environments[0], script, execution.id, plan) };
}
