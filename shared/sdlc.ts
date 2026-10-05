import { REVIEW_CHANNEL } from "./reviewRequest.ts";
import type { PullRequest, SdlcEnvironment, SdlcEvent, Ticket } from "./types.ts";

/**
 * Where a ticket's change is on its way to prod. Most stages read another system as the source
 * of truth (GitHub for PRs, Jira for Done); only smoketests and confirmed deploys are stored here.
 * Each smoketest has two stages: an agent plans it, then runs the plan once it is confirmed.
 * The order is a recommendation, not a gate: a later stage that is done marks the open stages
 * before it as skipped.
 */

export const ENVIRONMENTS: { id: SdlcEnvironment; label: string }[] = [
  { id: "localhost", label: "localhost" },
  { id: "fern_dev", label: "Fern Dev" },
  { id: "fern_prod", label: "Fern Prod" },
  { id: "postman_beta", label: "Postman Beta" },
  { id: "postman_prod", label: "Postman Prod" },
];

export const ENV_LABEL = Object.fromEntries(ENVIRONMENTS.map((e) => [e.id, e.label])) as Record<SdlcEnvironment, string>;

/** "postman_beta", "Postman Beta" and "postman-beta" are all the same tag. */
export function parseEnvironment(s: string): SdlcEnvironment | null {
  const norm = s.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ENVIRONMENTS.find((e) => e.id === norm || e.label.toLowerCase().replace(/\s+/g, "_") === norm)?.id ?? null;
}

export type StageId =
  | "ideation"
  | "pr"
  | "local_smoketest_plan"
  | "local_smoketest"
  | "review_requested"
  | "in_beta"
  | "beta_smoketest_plan"
  | "beta_smoketest"
  | "in_prod"
  | "prod_smoketest_plan"
  | "prod_smoketest"
  | "done";

/**
 * "waiting": a deploy PR merged, unconfirmed in Argo; or a smoketest plan that waits for Piper's confirmation.
 * "running": a smoketest has no result yet, or its plan is still being written.
 */
export type StageState = "done" | "failed" | "blocked" | "running" | "waiting" | "skipped" | "todo";

export interface Stage {
  id: StageId;
  label: string;
  state: StageState;
  /** One line on what made the state: the PR, the event, or what is missing. */
  detail: string;
  /** The SDLC events behind the state, newest first. */
  events: SdlcEvent[];
}

export interface SdlcProgress {
  stages: Stage[];
  /** The furthest stage that is done or skipped. Ideation is always done. */
  current: number;
  /** The stage after `current`, or null when the ticket is done. */
  next: Stage | null;
  /** What to do next, in one sentence. */
  hint: string | null;
}

/** Fern Dev is the pre-prod environment of Fern's own stack, so it counts for Beta. */
const STAGE_ENVS: Record<"local" | "beta" | "prod", SdlcEnvironment[]> = {
  local: ["localhost"],
  beta: ["postman_beta", "fern_dev"],
  prod: ["postman_prod", "fern_prod"],
};

/** A PR in one of these repos deploys a chart version; its base branch picks the stage, so the repo does too. */
export const DEPLOY_REPOS: Record<"beta" | "prod", string> = {
  beta: "postman-eng/cloud9-parcels-deployments",
  prod: "postman-eng/cloud9-parcels-production-deployments",
};

export function deployStageOf(pr: PullRequest): "beta" | "prod" | null {
  if (pr.repo === DEPLOY_REPOS.beta) return "beta";
  if (pr.repo === DEPLOY_REPOS.prod) return "prod";
  return null;
}

const AUTO_ACCEPT = "A plan that changes no Beta or Prod state is accepted at once.";

const HINTS: Record<StageId, string> = {
  ideation: "",
  pr: "Open a PR for the change.",
  local_smoketest_plan: `Plan a smoketest on localhost before you ask for a PR review. ${AUTO_ACCEPT}`,
  local_smoketest: "Run the confirmed plan of the local smoketest.",
  review_requested: `Ask for a review in #${REVIEW_CHANNEL.name}: the PRs view has a drafted message for each open PR.`,
  in_beta: "Deploy to Postman Beta (merge the PR, then the us-beta deploy PR), and confirm the deploy in Argo.",
  beta_smoketest_plan: `Plan a smoketest on Postman Beta before you open the prod chart version update PR. ${AUTO_ACCEPT}`,
  beta_smoketest: "Run the confirmed plan of the Beta smoketest.",
  in_prod: "Open the prod chart version update PR, and confirm the deploy in Argo after it merges.",
  prod_smoketest_plan: `Plan a smoketest on Postman Prod. ${AUTO_ACCEPT}`,
  prod_smoketest: "Run the confirmed plan of the Prod smoketest.",
  done: "Move the ticket to Done in Jira.",
};

export const STAGE_LABELS: Record<StageId, string> = {
  ideation: "Ideation",
  pr: "PR exists",
  local_smoketest_plan: "Local test plan",
  local_smoketest: "Local smoketest",
  review_requested: "Review requested",
  in_beta: "In Beta",
  beta_smoketest_plan: "Beta test plan",
  beta_smoketest: "Beta smoketest",
  in_prod: "In Prod",
  prod_smoketest_plan: "Prod test plan",
  prod_smoketest: "Prod smoketest",
  done: "Ticket done",
};

function newestFirst(events: SdlcEvent[]): SdlcEvent[] {
  return [...events].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id);
}

function tagged(events: SdlcEvent[], type: SdlcEvent["eventType"], envs: SdlcEnvironment[]): SdlcEvent[] {
  return newestFirst(events.filter((e) => e.eventType === type && e.environments.some((x) => envs.includes(x))));
}

/** Needs a session id: a hand record with no outcome still counts as passed. */
export function isSmoketestRunning(e: SdlcEvent): boolean {
  return e.eventType === "smoketest_execution" && !!e.sessionId && !e.finishedAt && !e.outcome && !e.skippedAt;
}

/** An agent still writes the plan: it has recorded no version yet. */
export function isPlanRunning(e: SdlcEvent): boolean {
  return e.eventType === "smoketest_plan" && !e.plannedAt;
}

/** A recorded plan that changes Beta or Prod state, and that Piper has not confirmed. */
export function isPlanWaiting(e: SdlcEvent): boolean {
  return e.eventType === "smoketest_plan" && !!e.plannedAt && !e.confirmedAt;
}

const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

function planStage(id: StageId, events: SdlcEvent[], envs: SdlcEnvironment[]): Omit<Stage, "label"> {
  const found = tagged(events, "smoketest_plan", envs);
  const last = found[0];
  if (!last) return { id, state: "todo", detail: `No smoketest plan tagged ${envs.map((e) => ENV_LABEL[e]).join(" or ")} yet`, events: [] };
  if (isPlanRunning(last)) return { id, state: "running", detail: `An agent writes the plan since ${utc(last.startedAt)}`, events: found };
  if (isPlanWaiting(last)) return { id, state: "waiting", detail: "The plan changes Beta or Prod state, so it waits for your confirmation", events: found };
  const when = (last.confirmedAt ?? last.startedAt).slice(0, 10);
  return { id, state: "done", detail: last.confirmedBy === "auto" ? `Plan accepted at once ${when}: it changes no Beta or Prod state` : `Plan confirmed by you ${when}`, events: found };
}

function smoketestStage(id: StageId, events: SdlcEvent[], envs: SdlcEnvironment[]): Omit<Stage, "label"> {
  const found = tagged(events, "smoketest_execution", envs);
  const last = found[0];
  if (!last) return { id, state: "todo", detail: `No smoketest tagged ${envs.map((e) => ENV_LABEL[e]).join(" or ")} yet`, events: [] };
  if (last.skippedAt) return { id, state: "skipped", detail: `Smoketest skipped ${last.skippedAt.slice(0, 10)}`, events: found };
  if (isSmoketestRunning(last)) return { id, state: "running", detail: `Smoketest running since ${utc(last.startedAt)}`, events: found };
  const when = (last.finishedAt ?? last.startedAt).slice(0, 10);
  // The newest run decides: a fix after a failed run shows as done again.
  if (last.outcome === "failed") return { id, state: "failed", detail: `The newest smoketest failed (${when})`, events: found };
  if (last.outcome === "blocked") return { id, state: "blocked", detail: `The newest smoketest was blocked (${when})`, events: found };
  return { id, state: "done", detail: `Smoketest ${last.outcome ?? "recorded"} ${when}`, events: found };
}

function deployStage(id: StageId, events: SdlcEvent[], prs: PullRequest[], stage: "beta" | "prod"): Omit<Stage, "label"> {
  const found = tagged(events, "deploy", STAGE_ENVS[stage]);
  if (found[0]) return { id, state: "done", detail: (found[0].testDetails ?? "Deploy confirmed").split("\n")[0], events: found };
  const deployPrs = prs.filter((p) => deployStageOf(p) === stage);
  const merged = deployPrs.find((p) => p.state === "merged");
  if (merged) return { id, state: "waiting", detail: `Deploy PR #${merged.number} merged; confirm the deploy in Argo`, events: [] };
  const open = deployPrs.find((p) => p.state === "open");
  return { id, state: "todo", detail: open ? `Deploy PR #${open.number} is open` : "No confirmed deploy", events: [] };
}

/** "postman-eng/repo#12" from a PR URL. */
function prLabel(url: string): string {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : url;
}

/** Done once agent-dash posted a Slack review request for any of the ticket's PRs. */
function reviewStage(events: SdlcEvent[]): Omit<Stage, "label"> {
  const found = newestFirst(events.filter((e) => e.eventType === "review_request"));
  const last = found[0];
  if (!last) return { id: "review_requested", state: "todo", detail: `No review request posted to #${REVIEW_CHANNEL.name} yet`, events: [] };
  const prs = [...new Set(found.map((e) => e.prUrl).filter((u): u is string => !!u))];
  const more = prs.length > 1 ? ` and ${prs.length - 1} more PR${prs.length > 2 ? "s" : ""}` : "";
  return { id: "review_requested", state: "done", detail: `Review requested for ${last.prUrl ? prLabel(last.prUrl) : "a PR"}${more} on ${last.startedAt.slice(0, 10)}`, events: found };
}

/** The dashboard's PRs plus the ticket's own GitHub search, once each. */
export function mergePrs(...lists: PullRequest[][]): PullRequest[] {
  const byUrl = new Map<string, PullRequest>();
  for (const p of lists.flat()) if (!byUrl.has(p.url)) byUrl.set(p.url, p);
  return [...byUrl.values()];
}

export function sdlcProgress({ ticket, prs, events }: { ticket: Ticket; prs: PullRequest[]; events: SdlcEvent[] }): SdlcProgress {
  const live = prs.filter((p) => p.state !== "closed");
  const code = live.filter((p) => !deployStageOf(p));
  const firstPr = (code[0] ?? live[0]) as PullRequest | undefined;
  const raw: Omit<Stage, "label">[] = [
    { id: "ideation", state: "done", detail: "", events: [] },
    {
      id: "pr",
      state: live.length ? "done" : "todo",
      detail: firstPr ? `${firstPr.repo}#${firstPr.number} (${firstPr.state})${live.length > 1 ? ` and ${live.length - 1} more` : ""}` : "No open or merged PR found on GitHub",
      events: [],
    },
    planStage("local_smoketest_plan", events, STAGE_ENVS.local),
    smoketestStage("local_smoketest", events, STAGE_ENVS.local),
    reviewStage(events),
    deployStage("in_beta", events, prs, "beta"),
    planStage("beta_smoketest_plan", events, STAGE_ENVS.beta),
    smoketestStage("beta_smoketest", events, STAGE_ENVS.beta),
    deployStage("in_prod", events, prs, "prod"),
    planStage("prod_smoketest_plan", events, STAGE_ENVS.prod),
    smoketestStage("prod_smoketest", events, STAGE_ENVS.prod),
    { id: "done", state: ticket.statusCategory === "done" ? "done" : "todo", detail: `Jira status: ${ticket.status}`, events: [] },
  ];
  const stages: Stage[] = raw.map((s) => ({ ...s, label: STAGE_LABELS[s.id] }));
  // A stage skipped on purpose is passed, so the order goes on after it.
  const current = stages.reduce((at, s, i) => (s.state === "done" || s.state === "skipped" ? i : at), 0);
  for (const s of stages.slice(0, current)) if (s.state === "todo") s.state = "skipped";
  const next = stages[current + 1] ?? null;
  let hint = next ? HINTS[next.id] : null;
  if (next?.state === "failed") hint = `The newest ${next.label.toLowerCase()} failed. Fix it, then run it again.`;
  if (next?.state === "blocked") hint = `The newest ${next.label.toLowerCase()} was blocked. Remove the blocker, then run it again, or skip it.`;
  if (next?.state === "waiting") hint = isPlanStage(next.id) ? `${next.detail}. Read it, refine it in its conversation, then confirm it.` : `${next.detail}.`;
  if (next?.state === "running") hint = isPlanStage(next.id) ? `${next.detail}. It records the plan here.` : `${next.detail}. An agent runs it and records the result here.`;
  return { stages, current, next, hint };
}

export function isPlanStage(id: StageId): boolean {
  return id.endsWith("_plan");
}

/** The environment that a smoketest stage, plan or execution, tests by default. */
export const SMOKETEST_ENV: Partial<Record<StageId, SdlcEnvironment>> = {
  local_smoketest_plan: "localhost",
  local_smoketest: "localhost",
  beta_smoketest_plan: "postman_beta",
  beta_smoketest: "postman_beta",
  prod_smoketest_plan: "postman_prod",
  prod_smoketest: "postman_prod",
};

/** The newest plan for the environments of a stage, so the execution stage can offer to run it. */
export function newestPlan(events: SdlcEvent[], env: SdlcEnvironment): SdlcEvent | null {
  const group = Object.values(STAGE_ENVS).find((envs) => envs.includes(env)) ?? [env];
  return tagged(events, "smoketest_plan", group)[0] ?? null;
}

/** For a summary run's or an agent's context: one line per stage. */
export function progressLines(p: SdlcProgress): string[] {
  const mark: Record<StageState, string> = { done: "[x]", failed: "[!] failed", blocked: "[?] blocked", running: "[~] running", waiting: "[~] waiting", skipped: "[-] skipped", todo: "[ ]" };
  return [
    ...p.stages.map((s, i) => `${i + 1}. ${mark[s.state]} ${s.label}${s.detail ? ` — ${s.detail}` : ""}`),
    "",
    p.next ? `Next stage: ${p.next.label}. ${p.hint}` : "Every stage is done.",
  ];
}

/** One line of the first message: clean text that cannot break out of the quotes or the line. */
function clean(s: string): string {
  return s.replace(/["\r\n`]/g, "").trim();
}

function recordCommand(script: string, key: string, type: "deploy", env: SdlcEnvironment): string {
  return `node ${script} ${type} --ticket ${key} --env ${env}`;
}

/** The environments where a smoketest needs Piper's confirmation before it changes state. */
export const SHARED_ENVS = "Postman Beta, Postman Prod, Fern Dev and Fern Prod";

function envNotes(env: SdlcEnvironment): string {
  const label = ENV_LABEL[env];
  if (env === "localhost") return "Read ~/pi/wiki/how-to/Local smoketesting.md first, and pick the local stack that exercises this change. The skill smoketest-happy-path-local scripts the publish-docs flow.";
  if (env === "fern_dev") return `${label} is shared team infrastructure. The skill smoketest-happy-path-dev scripts the publish-docs flow.`;
  const what = env === "postman_beta" ? "is shared team infrastructure" : "carries real customer traffic";
  return `${label} ${what}. Find the deployed version first (the argocd skill, read-only), so you know what you test.`;
}

/**
 * The first message of an agent that plans one smoketest and records the plan. `script` is the
 * absolute path of scripts/sdlc-event.ts, so the agent writes into this dash's database.
 */
export function planMessage(key: string, env: SdlcEnvironment, script: string, planId: number): string {
  const label = ENV_LABEL[env];
  return `Plan a smoketest of ${key} on ${label}. Write the plan only: do not run the test yet.

Work out from the context what the change does, and plan a test that shows that it works on ${label} from a user's point of view: the stack, URLs and versions, the steps, what you expect to see, and the evidence you will keep. ${envNotes(env)}

While you plan, change no state on ${SHARED_ENVS}: use read-only requests only. If the test must change state there (create or edit data, change a setting, deploy, sync), write each change in a state changes file: one line per change, with the system and the exact command or request. A change to local state only (a local database, local files) is not one of them.

agent-dash shows this plan as in progress (SDLC event ${planId}) until you record it, with one of these:
node ${script} plan --id ${planId} --plan-file <file> --state-changes none
node ${script} plan --id ${planId} --plan-file <file> --state-changes-file <file>
Use the first command only when the test changes no state on ${SHARED_ENVS}. agent-dash then accepts the plan at once, and the script tells you how to run it: run it in this turn. After the second command, Piper must confirm the plan in agent-dash first: reply with a short summary of the plan and its state changes, and stop. Piper can ask for changes in this conversation; record each new version with the same command. Piper's confirmation comes as a message, and it is the approval to make the state changes that the plan lists.`;
}

/**
 * The message that starts the run of an accepted plan: from Piper's Confirm, or from the script
 * when the plan changes no Beta or Prod state. Piper's confirmation names the approved writes
 * and repeats the plan, because the message can go to a new agent.
 */
export function executeMessage(key: string, env: SdlcEnvironment, script: string, executionId: number, plan: SdlcEvent): string {
  const label = ENV_LABEL[env];
  const byPiper = plan.confirmedBy === "piper";
  const approval = byPiper
    ? `Piper confirmed the smoketest plan of ${key} on ${label} (SDLC event ${plan.id}, the version recorded at ${plan.plannedAt}). This confirmation is Piper's approval to make the state changes that the plan lists, and only those:
${plan.stateChanges ?? "(none)"}

If the test needs another state change on ${SHARED_ENVS}, do not make it: record the smoketest as blocked, and say which change you need.`
    : `agent-dash accepted the smoketest plan of ${key} on ${label} (SDLC event ${plan.id}), because it changes no state on ${SHARED_ENVS}. Change no state there. If the test needs a change after all, do not make it: record the smoketest as blocked, and say which change you need.`;
  const planText = byPiper ? `

The plan:
<plan>
${plan.testDetails ?? ""}
</plan>` : "";
  return `${approval}

Run the plan now.${planText}

agent-dash shows this smoketest as running (SDLC event ${executionId}) until you record the result:
node ${script} finish --id ${executionId} --outcome passed|failed|blocked --summary "<one line>" --details-file <file> --results-file <file>
Write the summary after the test is done: one line of at most 120 characters that says what the test showed, for example "Publish flow works end to end" or "Docs page 500s after publish: missing FDR token". The page shows only the outcome and this line until Piper clicks it. Use blocked, not failed, when you could not run the test or could not see the result (no access, no test data, the environment is down): failed means the change does not work. The details file says what you tested and how (stack, commands, URLs, versions). The results file says what you saw, with the evidence, or what blocked you. Then reply with the outcome and a short summary.`;
}

/** The first message of an agent that confirms a deploy in Argo, read-only, and records it. */
export function confirmDeployMessage(key: string, stage: "beta" | "prod", prUrls: string[], script: string): string {
  const env: SdlcEnvironment = stage === "beta" ? "postman_beta" : "postman_prod";
  const label = ENV_LABEL[env];
  const prs = prUrls.length ? `The deploy PRs for ${key}: ${prUrls.map(clean).join(", ")}.` : `Find the deploy PR for ${key} in ${DEPLOY_REPOS[stage]}.`;
  return `Confirm that the change for ${key} is deployed to ${label}.

${prs} Use the argocd skill, read-only: find the Argo app that the deploy PR changes, and check that it is Synced and Healthy and runs the chart version or image from the PR. Do not sync, roll back, or change anything.

If the deploy is confirmed, record it:
${recordCommand(script, key, "deploy", env)} --details "<Argo app>: Synced, Healthy, <version>"
If it is not, record nothing, and tell Piper what you found.`;
}
