import { useState } from "react";
import { describeAction, FALLBACK_LABEL } from "../../shared/stepButton.ts";
import type { NextStep, StepAction } from "../../shared/types.ts";
import { conversationHash, launchAgent } from "./agents.tsx";
import { api } from "./lib.tsx";

type State = { kind: "idle" } | { kind: "busy" } | { kind: "started"; sessionId: string | null } | { kind: "done"; text: string } | { kind: "error"; message: string };

/**
 * The ticket's top next step as one button on its kanban card, so you start it without opening the
 * ticket. A click does the action that the server decided and that the label was written from, no other.
 */
export function CardStep({ ticket, status, step, action, cwd }: { ticket: string; status: string; step: NextStep; action: StepAction; cwd: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const run = async (terminal: boolean) => {
    setState({ kind: "busy" });
    try {
      if (action.kind === "move") {
        // The server moves it only from the status that the card shows: the click approved that move.
        const err = await api.moveTicket(ticket, action.to, status);
        return setState(err ? { kind: "error", message: err } : { kind: "done", text: `${action.to} ✓` });
      }
      setState({ kind: "started", sessionId: await launchAgent(ticket, { step: step.id, cwd, terminal }) });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  };
  if (action.kind === "move" && action.to === status && state.kind === "idle") return <span className="tag tone-good k-step">already {status}</span>;
  if (state.kind === "started") {
    return state.sessionId ? (
      <a className="btn ghost small k-step" href={conversationHash(state.sessionId)}>
        Started ✓ Open
      </a>
    ) : (
      <span className="tag tone-good k-step">Started ✓</span>
    );
  }
  if (state.kind === "done") return <span className="tag tone-good k-step">{state.text}</span>;
  const how = describeAction(ticket, action, cwd) + (action.kind === "agent" ? "\n\n⌥-click opens it in a new iTerm tab." : "");
  return (
    <button className={`btn small k-step ${state.kind === "error" ? "tone-bad" : ""}`} disabled={state.kind === "busy" || !cwd.trim()} onClick={(e) => run(e.altKey)} title={state.kind === "error" ? state.message : how}>
      {state.kind === "busy" ? "Starting…" : state.kind === "error" ? "Failed · Retry" : `▶ ${step.label ?? FALLBACK_LABEL}`}
    </button>
  );
}
