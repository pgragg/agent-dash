import { channelLabel, reviewChannelFor } from "./reviewRequest.ts";
import { team, User, user } from "./team.ts";
import type { PullRequest, SdlcEnvironment, SdlcEvent, Ticket } from "./types.ts";

/**
 * Where a ticket's change is on its way to prod. Most stages read another system as the source
 * of truth (GitHub for PRs, Jira for Done); only smoketests and confirmed deploys are stored here.
 * Each smoketest has two stages: an agent plans it, then runs the plan once it is confirmed.
 * The order is a recommendation, not a gate: a later stage that is done marks the open stages
 * before it as skipped.
 */

export type EnvStage = "local" | "beta" | "prod";

export interface Environment {
  id: SdlcEnvironment;
  label: string;
  stage: EnvStage;
}

/** "staging" is "Staging", "eu_prod" is "Eu Prod". */
const labelOf = (id: string): string => id.split(/[_-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** One `environments` entry, `stage:id`. */
export const ENVIRONMENT_SPEC = /^(beta|prod):([a-z][a-z0-9_]*)$/;

/**
 * localhost, then the shared environments of the settings in their order. A stage with none
 * gets one named after it, so every smoketest lane has an environment.
 */
export function environments(): Environment[] {
  const out: Environment[] = [{ id: "localhost", label: "localhost", stage: "local" }];
  for (const spec of team.environments) {
    const m = ENVIRONMENT_SPEC.exec(spec);
    if (m && !out.some((e) => e.id === m[2])) out.push({ id: m[2], label: labelOf(m[2]), stage: m[1] as EnvStage });
  }
  for (const stage of ["beta", "prod"] as const) {
    if (!out.some((e) => e.stage === stage) && !out.some((e) => e.id === stage)) out.push({ id: stage, label: labelOf(stage), stage });
  }
  return out;
}

/** The label of an environment. An old event can name one that the settings no longer have. */
export const envLabel = (id: SdlcEnvironment): string => environments().find((e) => e.id === id)?.label ?? id;

/** The environments of one stage, in the settings' order. */
export const stageEnvironments = (stage: EnvStage): SdlcEnvironment[] => environments().filter((e) => e.stage === stage).map((e) => e.id);

/** True where the Move things along agent may confirm and run a plan: localhost, and the allowed shared ones. */
export const autoRunAllowed = (id: SdlcEnvironment): boolean => id === "localhost" || team.autoRunEnvironments.includes(id);

/** "staging", "Staging" and "STAGING" are all the same tag. */
export function parseEnvironment(s: string): SdlcEnvironment | null {
  const norm = s.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return environments().find((e) => e.id === norm || e.label.toLowerCase().replace(/\s+/g, "_") === norm)?.id ?? null;
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
/** "unhealthy": the deploy is live, but the change does not give its benefit yet. It counts as reached. */
export type StageState = "done" | "unhealthy" | "failed" | "blocked" | "running" | "waiting" | "skipped" | "todo";

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

/** A PR in one of these repos deploys a chart version; its base branch picks the stage, so the repo does too. */
export const deployRepo = (stage: "beta" | "prod"): string => (stage === "beta" ? team.deployRepoBeta : team.deployRepoProd);

export function deployStageOf(pr: PullRequest): "beta" | "prod" | null {
  if (team.deployRepoBeta && pr.repo === team.deployRepoBeta) return "beta";
  if (team.deployRepoProd && pr.repo === team.deployRepoProd) return "prod";
  return null;
}

const AUTO_ACCEPT = "A plan that changes no Beta or Prod state is accepted at once.";

/** A function, not a constant: the review channel comes from the settings after this module loads. */
const hints = (ticket: string): Record<StageId, string> => ({
  ideation: "",
  pr: "Open a PR for the change.",
  local_smoketest_plan: `Plan a smoketest on localhost before you ask for a PR review. ${AUTO_ACCEPT}`,
  local_smoketest: "Run the confirmed plan of the local smoketest.",
  review_requested: reviewChannelFor([ticket]) ? `Ask for a review in ${channelLabel(reviewChannelFor([ticket])!)}: the PRs view has a drafted message for each open PR.` : "Ask for a review of each open PR.",
  in_beta: "Deploy to Beta (merge the PR, then the Beta deploy PR), and confirm the deploy in Argo.",
  beta_smoketest_plan: `Plan a smoketest on Beta before you open the Prod deploy PR. ${AUTO_ACCEPT}`,
  beta_smoketest: "Run the confirmed plan of the Beta smoketest.",
  in_prod: "Open the Prod deploy PR, and confirm the deploy in Argo after it merges.",
  prod_smoketest_plan: `Plan a smoketest on Prod. ${AUTO_ACCEPT}`,
  prod_smoketest: "Run the confirmed plan of the Prod smoketest.",
  done: "Move the ticket to Done in Jira.",
});

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
  if (!last) return { id, state: "todo", detail: `No smoketest plan tagged ${envs.map((e) => envLabel(e)).join(" or ")} yet`, events: [] };
  if (isPlanRunning(last)) return { id, state: "running", detail: `An agent writes the plan since ${utc(last.startedAt)}`, events: found };
  if (isPlanWaiting(last)) return { id, state: "waiting", detail: "The plan changes Beta or Prod state, so it waits for your confirmation", events: found };
  const when = (last.confirmedAt ?? last.startedAt).slice(0, 10);
  return { id, state: "done", detail: last.confirmedBy === "auto" ? `Plan accepted at once ${when}: it changes no Beta or Prod state` : `Plan confirmed by you ${when}`, events: found };
}

function smoketestStage(id: StageId, events: SdlcEvent[], envs: SdlcEnvironment[]): Omit<Stage, "label"> {
  const found = tagged(events, "smoketest_execution", envs);
  const last = found[0];
  if (!last) return { id, state: "todo", detail: `No smoketest tagged ${envs.map((e) => envLabel(e)).join(" or ")} yet`, events: [] };
  if (last.skippedAt) return { id, state: "skipped", detail: `Smoketest skipped ${last.skippedAt.slice(0, 10)}`, events: found };
  if (isSmoketestRunning(last)) return { id, state: "running", detail: `Smoketest running since ${utc(last.startedAt)}`, events: found };
  const when = (last.finishedAt ?? last.startedAt).slice(0, 10);
  // The newest run decides: a fix after a failed run shows as done again.
  if (last.outcome === "failed") return { id, state: "failed", detail: `The newest smoketest failed (${when})`, events: found };
  if (last.outcome === "blocked") return { id, state: "blocked", detail: `The newest smoketest was blocked (${when})`, events: found };
  return { id, state: "done", detail: `Smoketest ${last.outcome ?? "recorded"} ${when}`, events: found };
}

function deployStage(id: StageId, events: SdlcEvent[], prs: PullRequest[], stage: "beta" | "prod"): Omit<Stage, "label"> {
  const found = tagged(events, "deploy", stageEnvironments(stage));
  // The newest deploy decides: a healthy check after an unhealthy one shows as done.
  if (found[0]) return { id, state: found[0].outcome === "unhealthy" ? "unhealthy" : "done", detail: (found[0].testDetails ?? "Deploy confirmed").split("\n")[0], events: found };
  const deployPrs = prs.filter((p) => deployStageOf(p) === stage);
  const merged = deployPrs.find((p) => p.state === "merged");
  if (merged) return { id, state: "waiting", detail: `Deploy PR #${merged.number} merged; confirm the deploy in Argo`, events: [] };
  const open = deployPrs.find((p) => p.state === "open");
  return { id, state: "todo", detail: open ? `Deploy PR #${open.number} is open` : "No confirmed deploy", events: [] };
}

/** "acme/repo#12" from a PR URL. */
function prLabel(url: string): string {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : url;
}

/** Done once agent-dash posted a Slack review request for any of the ticket's PRs. */
function reviewStage(ticket: string, events: SdlcEvent[]): Omit<Stage, "label"> {
  const found = newestFirst(events.filter((e) => e.eventType === "review_request"));
  const last = found[0];
  if (!last) return { id: "review_requested", state: "todo", detail: reviewChannelFor([ticket]) ? `No review request posted to #${reviewChannelFor([ticket])!.name} yet` : "No review request posted from agent-dash", events: [] };
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
    planStage("local_smoketest_plan", events, stageEnvironments("local")),
    smoketestStage("local_smoketest", events, stageEnvironments("local")),
    reviewStage(ticket.key, events),
    deployStage("in_beta", events, prs, "beta"),
    planStage("beta_smoketest_plan", events, stageEnvironments("beta")),
    smoketestStage("beta_smoketest", events, stageEnvironments("beta")),
    deployStage("in_prod", events, prs, "prod"),
    planStage("prod_smoketest_plan", events, stageEnvironments("prod")),
    smoketestStage("prod_smoketest", events, stageEnvironments("prod")),
    { id: "done", state: ticket.statusCategory === "done" ? "done" : "todo", detail: `Jira status: ${ticket.status}`, events: [] },
  ];
  const stages: Stage[] = raw.map((s) => ({ ...s, label: STAGE_LABELS[s.id] }));
  // A stage skipped on purpose is passed, so the order goes on after it.
  const current = stages.reduce((at, s, i) => (s.state === "done" || s.state === "unhealthy" || s.state === "skipped" ? i : at), 0);
  for (const s of stages.slice(0, current)) if (s.state === "todo") s.state = "skipped";
  const next = stages[current + 1] ?? null;
  let hint = next ? hints(ticket.key)[next.id] : null;
  if (next?.state === "failed") hint = `The newest ${next.label.toLowerCase()} failed. Fix it, then run it again.`;
  if (next?.state === "blocked") hint = `The newest ${next.label.toLowerCase()} was blocked. Remove the blocker, then run it again, or skip it.`;
  if (next?.state === "waiting") hint = isPlanStage(next.id) ? `${next.detail}. Read it, refine it in its conversation, then confirm it.` : `${next.detail}.`;
  if (next?.state === "running") hint = isPlanStage(next.id) ? `${next.detail}. It records the plan here.` : `${next.detail}. An agent runs it and records the result here.`;
  return { stages, current, next, hint };
}

export function isPlanStage(id: StageId): boolean {
  return id.endsWith("_plan");
}

/** The environment that a smoketest stage, plan or execution, tests by default. Null: not a smoketest stage. */
export function smoketestEnv(id: StageId): SdlcEnvironment | null {
  const stage = (["local", "beta", "prod"] as const).find((x) => id === `${x}_smoketest_plan` || id === `${x}_smoketest`);
  return stage ? stageEnvironments(stage)[0] : null;
}

/** The newest plan for the environments of a stage, so the execution stage can offer to run it. */
export function newestPlan(events: SdlcEvent[], env: SdlcEnvironment): SdlcEvent | null {
  const stage = environments().find((e) => e.id === env)?.stage;
  return tagged(events, "smoketest_plan", stage ? stageEnvironments(stage) : [env])[0] ?? null;
}

/** A row of the Smoketests card: one smoketest stage pair of the bar, and its events. */
export interface SmoketestLane {
  id: "local" | "beta" | "prod";
  label: string;
  envs: SdlcEnvironment[];
  plan: Stage;
  run: Stage;
  /** Plans and executions, newest first. */
  events: SdlcEvent[];
  /** Executions only, oldest first: the history strip reads left to right. */
  runs: SdlcEvent[];
  /** The environment of the newest event, else the stage default. */
  env: SdlcEnvironment;
  /** "later": both stages come after the bar's next stage, so the row is not where to look now. */
  emphasis: "next" | "later" | "none";
}

const LANES: { id: SmoketestLane["id"]; label: string; plan: StageId; run: StageId }[] = [
  { id: "local", label: "Local", plan: "local_smoketest_plan", run: "local_smoketest" },
  { id: "beta", label: "Beta", plan: "beta_smoketest_plan", run: "beta_smoketest" },
  { id: "prod", label: "Prod", plan: "prod_smoketest_plan", run: "prod_smoketest" },
];

export function smoketestLanes(p: SdlcProgress, events: SdlcEvent[]): SmoketestLane[] {
  const nextAt = p.next ? p.stages.indexOf(p.next) : p.stages.length;
  return LANES.map((l) => {
    const all = stageEnvironments(l.id);
    const envs = all;
    const at = p.stages.findIndex((s) => s.id === l.plan);
    const mine = newestFirst(events.filter((e) => (e.eventType === "smoketest_plan" || e.eventType === "smoketest_execution") && e.environments.some((x) => all.includes(x))));
    const emphasis = p.next?.id === l.plan || p.next?.id === l.run ? "next" : at > nextAt ? "later" : "none";
    return {
      id: l.id,
      label: l.label,
      envs,
      plan: p.stages[at],
      run: p.stages[at + 1],
      events: mine,
      runs: mine.filter((e) => e.eventType === "smoketest_execution").reverse(),
      env: mine[0]?.environments.find((x) => all.includes(x)) ?? envs[0],
      emphasis,
    };
  });
}

/** For a summary run's or an agent's context: one line per stage. */
export function progressLines(p: SdlcProgress): string[] {
  const mark: Record<StageState, string> = { done: "[x]", unhealthy: "[~] unhealthy", failed: "[!] failed", blocked: "[?] blocked", running: "[~] running", waiting: "[~] waiting", skipped: "[-] skipped", todo: "[ ]" };
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

/** The environments where a smoketest needs the user's confirmation before it changes state, in words. */
export function sharedEnvs(): string {
  const labels = environments().filter((e) => e.stage !== "local").map((e) => e.label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
}

/** The environments that a smoketest can be planned or recorded on now. */
export const enabledEnvironments = environments;

function envNotes(env: SdlcEnvironment, guide: string): string {
  const e = environments().find((x) => x.id === env);
  if (!e || e.stage === "local") return `${guide ? `Read ${guide} first, and pick` : "Pick"} the local stack that exercises this change.`;
  const what = e.stage === "beta" ? "is shared team infrastructure" : "carries real customer traffic";
  return `${e.label} ${what}. Find the deployed version first (read-only, for example in Argo CD), so you know what you test.`;
}

/**
 * The first message of an agent that plans one smoketest and records the plan. `script` is the
 * absolute path of scripts/sdlc-event.ts, so the agent writes into this dash's database.
 */
/** `guide` is a file that a local plan reads first; empty for none. */
export function planMessage(key: string, env: SdlcEnvironment, script: string, planId: number, guide = ""): string {
  const label = envLabel(env);
  return `Plan a smoketest of ${key} on ${label}. Write the plan only: do not run the test yet.

Work out from the context what the change does, and plan a test that shows that it works on ${label} from a user's point of view: the stack, URLs and versions, the steps, what you expect to see, and the evidence you will keep. ${envNotes(env, guide)}

While you plan, change no state on ${sharedEnvs()}: use read-only requests only. If the test must change state there (create or edit data, change a setting, deploy, sync), write each change in a state changes file: one line per change, with the system and the exact command or request. A change to local state only (a local database, local files) is not one of them.

agent-dash shows this plan as in progress (SDLC event ${planId}) until you record it, with one of these:
node ${script} plan --id ${planId} --summary "<plan summary>" --plan-file <file> --state-changes none
node ${script} plan --id ${planId} --summary "<plan summary>" --writes-summary "<writes summary>" --plan-file <file> --state-changes-file <file>
${User()} reads the two summaries first, at the top of the plan. The plan summary is one or two short sentences: what the test does and what it shows. The writes summary says, per environment, what the test writes there, in a few words, for example "Beta: create one test project, then delete it". The files hold the details.
Use the first command only when the test changes no state on ${sharedEnvs()}. agent-dash then accepts the plan at once, and the script tells you how to run it: run it in this turn. After the second command, ${user()} must confirm the plan in agent-dash first: reply with a short summary of the plan and its state changes, and stop. ${User()} can ask for changes in this conversation; record each new version with the same command. ${User()}'s confirmation comes as a message, and it is the approval to make the state changes that the plan lists.`;
}

/**
 * The message that starts the run of an accepted plan: from Piper's Confirm, or from the script
 * when the plan changes no Beta or Prod state. Piper's confirmation names the approved writes
 * and repeats the plan, because the message can go to a new agent.
 */
export function executeMessage(key: string, env: SdlcEnvironment, script: string, executionId: number, plan: SdlcEvent): string {
  const label = envLabel(env);
  const byPerson = !!plan.confirmedBy && plan.confirmedBy !== "auto";
  const approval = byPerson
    ? `${User()} confirmed the smoketest plan of ${key} on ${label} (SDLC event ${plan.id}, the version recorded at ${plan.plannedAt}). This confirmation is ${user()}'s approval to make the state changes that the plan lists, and only those:
${plan.stateChanges ?? "(none)"}

If the test needs another state change on ${sharedEnvs()}, do not make it: record the smoketest as blocked, and say which change you need.`
    : `agent-dash accepted the smoketest plan of ${key} on ${label} (SDLC event ${plan.id}), because it changes no state on ${sharedEnvs()}. Change no state there. If the test needs a change after all, do not make it: record the smoketest as blocked, and say which change you need.`;
  const planText = byPerson ? `

The plan:
<plan>
${plan.testDetails ?? ""}
</plan>` : "";
  return `${approval}

Before you change any state, check the context for another agent that works on this smoketest of ${key} on ${label}. If one does, do not run the plan: tell ${user()}, and stop.

Run the plan now.${planText}

agent-dash shows this smoketest as running (SDLC event ${executionId}) until you record the result:
node ${script} finish --id ${executionId} --outcome passed|failed|blocked --summary "<one line>" --details-file <file> --results-file <file>
Write the summary after the test is done: one line of at most 120 characters that says what the test showed, for example "Checkout flow works end to end" or "Order page 500s after checkout: missing API token". The page shows only the outcome and this line until ${user()} clicks it. Use blocked, not failed, when you could not run the test or could not see the result (no access, no test data, the environment is down): failed means the change does not work. The details file says what you tested and how (stack, commands, URLs, versions). The results file says what you saw, with the evidence, or what blocked you. Then reply with the outcome and a short summary.`;
}

/** The first message of an agent that confirms a deploy in Argo, read-only, and records it. */
export function confirmDeployMessage(key: string, stage: "beta" | "prod", prUrls: string[], script: string): string {
  const env = stageEnvironments(stage)[0];
  const label = envLabel(env);
  const repo = deployRepo(stage) || "the deploy repo";
  const prs = prUrls.length ? `The deploy PRs for ${key}: ${prUrls.map(clean).join(", ")}.` : `Find the deploy PR for ${key} in ${repo}.`;
  return `Confirm that the change for ${key} is deployed to ${label}.

${prs} Use Argo CD, read-only (the argocd CLI, or an argocd skill if you have one): find the Argo app that the deploy PR changes, and check that it is Synced and Healthy and runs the chart version or image from the PR. Do not sync, roll back, or change anything.

A deploy can have no PR: a build bot can commit the new chart version straight to ${repo}. Look for that commit too. When the new version is committed but Argo does not run it yet, wait: check again for up to 15 minutes before you report that it is not deployed.

If the deploy is confirmed, record it:
${recordCommand(script, key, "deploy", env)} --details "<Argo app>: Synced, Healthy, <version>"
If the change is live but does not give its benefit yet (for example, a dependency outside the change is broken), record it as unhealthy:
${recordCommand(script, key, "deploy", env)} --outcome unhealthy --details "<what is live>; <what still does not work>"
If it is not deployed, record nothing, and tell ${user()} what you found.`;
}
