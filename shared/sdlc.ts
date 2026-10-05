import { REVIEW_CHANNEL } from "./reviewRequest.ts";
import type { PullRequest, SdlcEnvironment, SdlcEvent, Ticket } from "./types.ts";

/**
 * Where a ticket's change is on its way to prod. Most stages read another system as the source
 * of truth (GitHub for PRs, Jira for Done); only smoketests and confirmed deploys are stored here.
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

export type StageId = "ideation" | "pr" | "local_smoketest" | "review_requested" | "in_beta" | "beta_smoketest" | "in_prod" | "prod_smoketest" | "done";

/** "waiting": a deploy PR merged, unconfirmed in Argo. "running": a smoketest has no result yet. */
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

const HINTS: Record<StageId, string> = {
  ideation: "",
  pr: "Open a PR for the change.",
  local_smoketest: "Run a smoketest on localhost before you ask for a PR review.",
  review_requested: `Ask for a review in #${REVIEW_CHANNEL.name}: the PRs view has a drafted message for each open PR.`,
  in_beta: "Deploy to Postman Beta (merge the PR, then the us-beta deploy PR), and confirm the deploy in Argo.",
  beta_smoketest: "Run a smoketest on Postman Beta before you open the prod chart version update PR.",
  in_prod: "Open the prod chart version update PR, and confirm the deploy in Argo after it merges.",
  prod_smoketest: "Run a smoketest on Postman Prod.",
  done: "Move the ticket to Done in Jira.",
};

export const STAGE_LABELS: Record<StageId, string> = {
  ideation: "Ideation",
  pr: "PR exists",
  local_smoketest: "Local smoketest",
  review_requested: "Review requested",
  in_beta: "In Beta",
  beta_smoketest: "Beta smoketest",
  in_prod: "In Prod",
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
  return e.eventType === "smoketest" && !!e.sessionId && !e.finishedAt && !e.outcome;
}

function smoketestStage(id: StageId, events: SdlcEvent[], envs: SdlcEnvironment[]): Omit<Stage, "label"> {
  const found = tagged(events, "smoketest", envs);
  const last = found[0];
  if (!last) return { id, state: "todo", detail: `No smoketest tagged ${envs.map((e) => ENV_LABEL[e]).join(" or ")} yet`, events: [] };
  if (last.skippedAt) return { id, state: "skipped", detail: `Smoketest skipped ${last.skippedAt.slice(0, 10)}`, events: found };
  if (isSmoketestRunning(last)) return { id, state: "running", detail: `Smoketest running since ${last.startedAt.slice(0, 16).replace("T", " ")} UTC`, events: found };
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
    smoketestStage("local_smoketest", events, STAGE_ENVS.local),
    reviewStage(events),
    deployStage("in_beta", events, prs, "beta"),
    smoketestStage("beta_smoketest", events, STAGE_ENVS.beta),
    deployStage("in_prod", events, prs, "prod"),
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
  if (next?.state === "waiting") hint = `${next.detail}.`;
  if (next?.state === "running") hint = `${next.detail}. An agent runs it and records the result here.`;
  return { stages, current, next, hint };
}

/** The environment that a smoketest stage tests by default. */
export const SMOKETEST_ENV: Partial<Record<StageId, SdlcEnvironment>> = {
  local_smoketest: "localhost",
  beta_smoketest: "postman_beta",
  prod_smoketest: "postman_prod",
};

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

function recordCommand(script: string, key: string, type: "smoketest" | "deploy", env: SdlcEnvironment): string {
  return `node ${script} ${type} --ticket ${key} --env ${env}`;
}

/**
 * The first message of an agent that runs one smoketest and records it. `script` is the
 * absolute path of scripts/sdlc-event.ts, so the agent writes into this dash's database.
 */
export function smoketestMessage(key: string, env: SdlcEnvironment, script: string, eventId: number): string {
  const label = ENV_LABEL[env];
  const how =
    env === "localhost"
      ? "Read ~/pi/wiki/how-to/Local smoketesting.md first, and pick the local stack that exercises this change. The skill smoketest-happy-path-local scripts the publish-docs flow."
      : env === "fern_dev"
        ? `${label} is shared team infrastructure: test with read-only requests, and write no data unless Piper says so. The skill smoketest-happy-path-dev scripts the publish-docs flow.`
        : env === "postman_beta"
          ? `${label} is shared team infrastructure: test with read-only requests, and write no data unless Piper says so. Find the deployed version first (the argocd skill, read-only), so you know what you test.`
          : `${label} carries real customer traffic: test with read-only requests only, and write no data unless Piper says so. Find the deployed version first (the argocd skill, read-only), so you know what you test.`;
  return `Run a smoketest of ${key} on ${label}.

Work out from the context what the change does, and test that it works on ${label} from a user's point of view. ${how}

agent-dash shows this smoketest as running (SDLC event ${eventId}) until you record the result. When you finish, record the result:
node ${script} finish --id ${eventId} --outcome passed|failed|blocked --details-file <file> --results-file <file>
Use blocked, not failed, when you could not run the test or could not see the result (no access, no test data, the environment is down): failed means the change does not work. The details file says what you tested and how (stack, commands, URLs, versions). The results file says what you saw, with the evidence, or what blocked you. Then reply with the outcome and a short summary.`;
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
