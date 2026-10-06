import { isPlanRunning, isPlanWaiting, isSmoketestRunning } from "../../shared/sdlc.ts";
import type { SdlcEnvironment, SdlcEvent } from "../../shared/types.ts";

/**
 * A waiting agent that agent-dash started for a smoketest plan or run shows as that smoketest
 * in the why list: the smoketest is what Piper acts on. Kept free of React so the tests can import it.
 */

const ENV_SHORT: Record<SdlcEnvironment, string> = { localhost: "Localhost", fern_dev: "Fern Dev", fern_prod: "Fern Prod", postman_beta: "Beta", postman_prod: "Prod" };

export interface SmoketestRow {
  /** The plan or execution that the agent works on: the newest one with its session. */
  event: SdlcEvent;
  /** The plan to confirm or run again. */
  plan: SdlcEvent | null;
  /** "Prod plan waits for your Confirm". */
  title: string;
  /** The status chip: "to confirm", "passed". */
  status: string;
  tone: "waiting" | "good" | "bad" | "warn" | "muted";
  /** One line under the title: the plan's writes, or what the run showed. */
  detail: string | null;
  action: "confirm" | "reply" | "run_again" | null;
  /** False for news: a passed run, or a plan that needs nothing more. */
  needsYou: boolean;
}

/** `asked`: the agent's last message is a question. `finished`: its summary says it needs nothing. */
export function smoketestRow(sessionId: string | undefined, events: SdlcEvent[], agent: { asked: boolean; finished: boolean }): SmoketestRow | null {
  if (!sessionId) return null;
  // The planning agent also runs its plan after the Confirm, so the newest event is the current one.
  const mine = events.filter((e) => e.sessionId === sessionId && (e.eventType === "smoketest_plan" || e.eventType === "smoketest_execution")).sort((a, b) => b.id - a.id);
  const event = mine[0];
  if (!event) return null;
  const env = ENV_SHORT[event.environments[0]] ?? "Smoketest";
  const plan = event.eventType === "smoketest_plan" ? event : (events.find((e) => e.id === event.planId) ?? null);
  const waits = agent.asked ? "the agent asked you a question" : "the agent waits for you";
  const reply = (what: string): SmoketestRow => ({ event, plan, title: `${env} ${what}: ${waits}`, status: agent.asked ? "question" : "waiting", tone: "waiting", detail: null, action: "reply", needsYou: true });

  if (event.eventType === "smoketest_plan") {
    if (isPlanWaiting(event)) return { event, plan, title: `${env} plan waits for your Confirm`, status: "to confirm", tone: "waiting", detail: event.writesSummary ?? event.summary, action: "confirm", needsYou: true };
    if (isPlanRunning(event) || !agent.finished) return reply("plan");
    return { event, plan, title: `${env} plan ${event.confirmedBy === "auto" ? "accepted" : "confirmed"}`, status: "planned", tone: "good", detail: event.summary, action: null, needsYou: false };
  }
  if (isSmoketestRunning(event)) return reply("smoketest");
  const outcome = event.outcome ?? "passed";
  // A passed run is news, unless the agent still asks for something after it.
  if (outcome === "passed") return { event, plan, title: `${env} passed`, status: "passed", tone: "good", detail: event.summary, action: agent.finished ? null : "reply", needsYou: !agent.finished };
  return { event, plan, title: `${env} ${outcome}`, status: outcome, tone: outcome === "failed" ? "bad" : "warn", detail: event.summary, action: plan?.confirmedAt ? "run_again" : null, needsYou: true };
}
