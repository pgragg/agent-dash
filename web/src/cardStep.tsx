import { useState } from "react";
import { moveStepTarget, moveTargets } from "../../shared/jiraVerbs.ts";
import { FALLBACK_LABEL } from "../../shared/stepButton.ts";
import type { NextStep } from "../../shared/types.ts";
import { conversationHash, launchAgent } from "./agents.tsx";
import { api } from "./lib.tsx";
import { loadDetail } from "./ticketPanel.tsx";

type State = { kind: "idle" } | { kind: "busy" } | { kind: "started"; sessionId: string | null } | { kind: "done"; text: string } | { kind: "error"; message: string };

/**
 * The ticket's top next step as one button on its kanban card, so you start it without opening the
 * ticket. It does what the step's own button in the Next steps card does: a Jira move, else an agent.
 */
export function CardStep({ ticket, step, cwd, canMove }: { ticket: string; step: NextStep; cwd: string; canMove: boolean }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const run = async (terminal: boolean) => {
    setState({ kind: "busy" });
    try {
      // Read the transitions only when the step may be a move, as the Next steps card does.
      if (canMove && /\bmov/i.test(step.body)) {
        const detail = await loadDetail(ticket, false);
        const target = moveStepTarget(step.body, ticket, [...moveTargets(detail.transitions, detail.status), { to: detail.status, via: null }]);
        if (target?.to === detail.status) return setState({ kind: "done", text: `already ${detail.status}` });
        if (target) {
          const err = await api.moveTicket(ticket, target.to, detail.status);
          return setState(err ? { kind: "error", message: err } : { kind: "done", text: `${target.to} ✓` });
        }
      }
      setState({ kind: "started", sessionId: await launchAgent(ticket, { step: step.id, cwd, terminal }) });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  };
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
  return (
    <button
      className={`btn small k-step ${state.kind === "error" ? "tone-bad" : ""}`}
      disabled={state.kind === "busy" || !cwd.trim()}
      onClick={(e) => run(e.altKey)}
      title={state.kind === "error" ? state.message : `Next step: ${step.body}\n\nStarts it as the Next steps card does, in ${cwd}. ⌥-click opens it in a new iTerm tab.`}
    >
      {state.kind === "busy" ? "Starting…" : state.kind === "error" ? "Failed · Retry" : `▶ ${step.label ?? FALLBACK_LABEL}`}
    </button>
  );
}
