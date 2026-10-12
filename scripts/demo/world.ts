/**
 * The fictional world of the demo dashboard: the tickets, agent sessions, PRs and drafts that the
 * README screenshots show. Every name here is made up (Acme, Sam, Alex, Jordan), so a screenshot
 * can never show a real ticket, person or repo. Times are relative to `now`.
 */

export const USER = "Sam";
export const GH_LOGIN = "sam";

const MIN = 60_000;
export const ago = (now: number, minutes: number) => new Date(now - minutes * MIN).toISOString();
const day = (now: number, days: number) => new Date(now + days * 86_400_000).toISOString().slice(0, 10);

export interface DemoTicket {
  key: string;
  summary: string;
  status: string;
  priority: string;
  /** Days from today; negative is overdue. */
  due?: number;
  updatedMin: number;
  description: string;
  comments?: { author: string; minAgo: number; body: string }[];
}

export const TICKETS: DemoTicket[] = [
  {
    key: "ACME-412",
    summary: "Release bot: read the new config file, not the old one",
    status: "In Progress",
    priority: "High",
    due: 9,
    updatedMin: 50,
    description:
      "## Impact\nThe release bot reads `legacy.yml` to build each release. Teams that moved to `release.yml` get no release.\n\n## Expected behaviour\nThe bot reads `release.yml` when it exists, and `legacy.yml` when it does not.\n\n## Steps to reproduce\n1. Move a repo to `release.yml`.\n2. Merge a change to that repo.\n3. See that the bot makes no release.\n\n## Workarounds\nNone. Keep `legacy.yml` until this ships.",
    comments: [{ author: "Alex Kim", minAgo: 26 * 60, body: "Staging has the new build. Can you run the smoketest there before we go to prod?" }],
  },
  { key: "ACME-398", summary: "Fix autoscaling for the search indexer in prod", status: "In Progress", priority: "Highest", due: 3, updatedMin: 180, description: "The indexer scales on CPU, but it is IO-bound. Scale it on the queue depth instead." },
  { key: "ACME-415", summary: "Staging docs build fails: the API is unreachable from CI", status: "In Progress", priority: "Medium", due: 6, updatedMin: 20, description: "The docs build calls the Staging API, which CI cannot reach. Use the API mock in CI." },
  { key: "ACME-421", summary: "Connect the code-review bot to the new GitHub org", status: "In Progress", priority: "High", due: 14, updatedMin: 130, description: "The review bot must open sessions in `acme/web-platform`, not `acme/legacy-platform`." },
  { key: "ACME-430", summary: "Draft the release notes for v2.3", status: "To Do", priority: "Medium", due: 5, updatedMin: 30, description: "Collect the merged changes since v2.2 and write the release notes." },
  { key: "ACME-433", summary: "Update the on-call runbook for the release bot", status: "In Progress", priority: "Low", due: -2, updatedMin: 6 * 24 * 60, description: "The runbook still says to restart the bot by hand." },
  { key: "ACME-77", summary: "Move the search service to the new cluster", status: "In Progress", priority: "Medium", updatedMin: 5 * 24 * 60, description: "Move the search service and its indexer to the new cluster." },
  { key: "ACME-405", summary: "Rotate the search service API key", status: "On Hold", priority: "Medium", updatedMin: 2 * 24 * 60, description: "Rotate the key after the cluster move." },
  { key: "ACME-440", summary: "Test the docs site on staging", status: "Backlog", priority: "Low", updatedMin: 35 * 24 * 60, description: "" },
  { key: "ACME-441", summary: "Remove the hardcoded search hostname", status: "Backlog", priority: "Low", updatedMin: 14 * 24 * 60, description: "" },
  { key: "ACME-442", summary: "Load the dashboard tokens from the secret store", status: "To Do", priority: "Medium", updatedMin: 8 * 24 * 60, description: "" },
];

export const CATEGORY: Record<string, string> = { Backlog: "new", "To Do": "new", "In Progress": "indeterminate", "In Review": "indeterminate", "On Hold": "indeterminate", Done: "done" };

export function jiraIssue(t: DemoTicket, now: number) {
  return {
    key: t.key,
    fields: {
      summary: t.summary,
      status: { name: t.status, statusCategory: { key: CATEGORY[t.status] } },
      priority: { name: t.priority },
      duedate: t.due === undefined ? null : day(now, t.due),
      updated: ago(now, t.updatedMin),
      assignee: { displayName: USER },
    },
  };
}

// ---- agent sessions -------------------------------------------------------------------

type Turn = { user: string } | { agent: string } | { tool: string; result: string };

export interface DemoRun {
  id: string;
  name?: string;
  cwd: string;
  startedMin: number;
  /** The log's last change. */
  activeMin: number;
  turns: Turn[];
  /** Live runs get a status file with a living pid. Finished runs get a closed one. */
  state: "working" | "awaiting_input" | "closed";
  sinceMin: number;
  activity?: { tool: string; summary: string; sinceSec: number };
  gist: { about: string; latest: string; needs: string; title?: string };
}

const id = (n: number) => `5a1e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const RUNS: DemoRun[] = [
  {
    id: id(1),
    name: "ACME-412: Plan a smoketest of ACME-412 on Staging",
    cwd: "src/release-bot",
    startedMin: 190,
    activeMin: 62,
    state: "awaiting_input",
    sinceMin: 62,
    turns: [
      { user: "Plan a smoketest of ACME-412 on Staging, then run it." },
      { tool: "gh api repos/acme-demo/release-smoke/releases --jq length", result: "HTTP 404: Not Found" },
      { agent: "The Staging smoketest is blocked. The release bot's GitHub App is private and is installed only on acme-demo, and your gh token has no access to that org.\n\nDo you want to authorize the token for acme-demo, or skip the Staging smoketest for now?" },
    ],
    gist: {
      about: "ACME-412 Staging smoketest, blocked by GitHub App access",
      latest: "The release bot app is private and installed only on acme-demo. Your gh token has no access to that org, so the test cannot create a release.",
      needs: "Authorize the gh token for the acme-demo org, or say to skip the Staging smoketest",
    },
  },
  {
    id: id(2),
    name: "ACME-412: Update the migration guide for release.yml",
    cwd: "src/release-bot",
    startedMin: 40,
    activeMin: 1,
    state: "working",
    sinceMin: 14,
    activity: { tool: "bash", summary: "pnpm test docs/migration.test.ts", sinceSec: 12 },
    turns: [
      { user: "Update the migration guide: add a release.yml section and a before-and-after example." },
      { agent: "I added the release.yml section. Now I run the docs tests." },
    ],
    gist: { about: "Update the migration guide for release.yml", latest: "Added the release.yml section and a before-and-after example to the guide.", needs: "Nothing now: the agent is working." },
  },
  {
    id: id(3),
    name: "ACME-398: Scale the search indexer on queue depth",
    cwd: "src/search",
    startedMin: 600,
    activeMin: 175,
    state: "awaiting_input",
    sinceMin: 175,
    turns: [
      { user: "Make the search indexer scale on queue depth, not CPU, and open a PR." },
      { tool: 'gh pr create --title "ACME-398: scale the indexer on queue depth, not CPU"', result: "https://github.com/acme/search/pull/77" },
      { agent: "PR https://github.com/acme/search/pull/77 is approved, and CI is green.\n\nThe deploy freeze ends at 18:00. Do you want me to merge it now, or after the freeze?" },
    ],
    gist: { about: "ACME-398: scale the search indexer on queue depth", latest: "PR search#77 is approved and green. The deploy freeze ends at 18:00.", needs: "Say to merge search#77 now, or after the deploy freeze" },
  },
  {
    id: id(4),
    name: "ACME-415: Use the API mock in the docs build",
    cwd: "src/docs-site",
    startedMin: 300,
    activeMin: 2,
    state: "working",
    sinceMin: 6,
    activity: { tool: "bash", summary: "pnpm build:docs --api mock", sinceSec: 40 },
    turns: [
      { user: "Address Jordan's review on docs-site#58." },
      { agent: "Jordan asks to keep the real API for the nightly build. I add a flag for that, then rebuild." },
    ],
    gist: { about: "ACME-415: address the review on docs-site#58", latest: "Adds a flag that keeps the real API for the nightly build, as Jordan asked.", needs: "Nothing now: the agent is working." },
  },
  {
    id: id(5),
    name: "ACME-421: Point the review bot at acme/web-platform",
    cwd: "src/web-platform",
    startedMin: 160,
    activeMin: 125,
    state: "closed",
    sinceMin: 125,
    turns: [
      { user: "Point the review bot's create-session route at acme/web-platform, and open a PR." },
      { tool: 'gh pr create --title "ACME-421: point review bot sessions at acme/web-platform"', result: "https://github.com/acme/web-platform/pull/181" },
      { agent: "I opened https://github.com/acme/web-platform/pull/181. It changes one line in the create-session route." },
    ],
    gist: { about: "ACME-421: point the review bot at acme/web-platform", latest: "Opened web-platform#181, a one-line change to the create-session route.", needs: "Nothing" },
  },
  {
    id: id(6),
    cwd: "",
    startedMin: 70,
    activeMin: 38,
    state: "awaiting_input",
    sinceMin: 38,
    turns: [
      { user: "What should I work on today? Look at my open tickets and PRs." },
      { agent: "Three things need you today:\n1. search#77 is approved and green.\n2. web-platform#181 has red CI.\n3. ACME-433 is two days overdue.\n\nDo you want me to start an agent on the red CI first?" },
    ],
    gist: { title: "Plan today's work across open tickets", about: "What to work on today, from open tickets and PRs", latest: "Merge search#77, fix the red CI on web-platform#181, and update the overdue ACME-433 runbook.", needs: "Say if the agent starts on the red CI first" },
  },
  {
    id: id(7),
    name: "ACME-430: Draft the release notes for v2.3",
    cwd: "src/release-bot",
    startedMin: 90,
    activeMin: 27,
    state: "awaiting_input",
    sinceMin: 27,
    turns: [
      { user: "Draft the release notes for v2.3 from the merged PRs since v2.2." },
      { agent: "The draft has 14 items in docs/release-notes/v2.3.md. Four are internal refactors.\n\nShall I cut the four refactors?" },
    ],
    gist: { about: "ACME-430: release notes for v2.3", latest: "The draft has 14 items in docs/release-notes/v2.3.md. Four are internal refactors.", needs: "Say if the four internal refactors stay in the notes" },
  },
  {
    id: id(8),
    name: "ACME-77: Move the search service to the new cluster",
    cwd: "src/search",
    startedMin: 5 * 24 * 60,
    activeMin: 4 * 24 * 60,
    state: "closed",
    sinceMin: 4 * 24 * 60,
    turns: [
      { user: "Plan the move of the search service to the new cluster." },
      { agent: "The plan is in docs/cluster-move.md. The indexer moves last, after the API." },
    ],
    gist: { about: "ACME-77: plan the search service move", latest: "The plan is in docs/cluster-move.md. The indexer moves last.", needs: "Nothing" },
  },
  // Two parked agents: their asks show on the board.
  {
    id: id(9),
    name: "ACME-412: Check which org the Staging test bot can see",
    cwd: "src/release-bot",
    startedMin: 30 * 60,
    activeMin: 26 * 60,
    state: "closed",
    sinceMin: 26 * 60,
    turns: [
      { user: "Check which GitHub org the Staging test bot can see." },
      { agent: "The test bot can see acme-demo and acme-sandbox. Which org should the Staging smoketest use?" },
    ],
    gist: { about: "ACME-412: which org the Staging test bot sees", latest: "The test bot can see acme-demo and acme-sandbox.", needs: "Pick the Staging test org: acme-demo or acme-sandbox" },
  },
  {
    id: id(10),
    name: "ACME-421: Draft the GitHub App install request",
    cwd: "src/web-platform",
    startedMin: 8 * 60,
    activeMin: 7 * 60,
    state: "closed",
    sinceMin: 7 * 60,
    turns: [
      { user: "Draft the request to install the review bot's GitHub App on acme." },
      { agent: "The request is in install-request.md. Jordan approves app installs on acme. Is the text OK to send?" },
    ],
    gist: { about: "ACME-421: GitHub App install request", latest: "The request is in install-request.md. Jordan approves app installs on acme.", needs: "Approve the install request text before it goes to Jordan" },
  },
  // Finished chats for History.
  {
    id: id(11),
    cwd: "src/release-bot",
    startedMin: 26 * 60,
    activeMin: 25 * 60,
    state: "closed",
    sinceMin: 25 * 60,
    turns: [
      { user: "Explain how the release bot retries a failed release." },
      { agent: "It retries three times, with a 30 s, 2 min and 10 min wait. The fourth failure pages on-call." },
    ],
    gist: { title: "How the release bot retries a release", about: "How the release bot retries a failed release", latest: "Three retries, then it pages on-call.", needs: "Nothing" },
  },
  {
    id: id(12),
    cwd: "src/search",
    startedMin: 50 * 60,
    activeMin: 49 * 60,
    state: "closed",
    sinceMin: 49 * 60,
    turns: [
      { user: "Why is the search p99 latency higher since Monday?" },
      { agent: "The new synonym list doubled the query size. A cache for the expanded queries brings p99 back to 120 ms." },
    ],
    gist: { title: "Search p99 latency since Monday", about: "Why the search p99 latency went up", latest: "The new synonym list doubled the query size; a cache fixes it.", needs: "Nothing" },
  },
];

export const PARKED = [
  { run: id(9), ticket: "ACME-412", reason: "stale" as const, parkedMin: 120 },
  { run: id(10), ticket: "ACME-421", reason: "over_cap" as const, parkedMin: 95 },
];

// ---- pull requests ----------------------------------------------------------------------

export interface DemoPr {
  repo: string;
  number: number;
  title: string;
  branch: string;
  state: "OPEN" | "MERGED";
  draft?: boolean;
  review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checks: "SUCCESS" | "FAILURE" | "PENDING";
  merge: "CLEAN" | "BLOCKED" | "UNSTABLE";
  updatedMin: number;
  body: string;
  files: { path: string; additions: number; deletions: number }[];
  failed?: { name: string; job: number; log: string }[];
  passed: string[];
  reviews?: { author: string; state: string; body: string; minAgo: number }[];
  comments?: { author: string; body: string; minAgo: number }[];
  threads?: { path: string; line: number; comments: { author: string; body: string; minAgo: number }[] }[];
  draftPhrase: string;
}

export const PRS: DemoPr[] = [
  {
    repo: "acme/release-bot",
    number: 239,
    title: "fix(release-bot): build targets from release.yml [ACME-412]",
    branch: "sam/ACME-412-release-yml",
    state: "MERGED",
    review: "APPROVED",
    checks: "SUCCESS",
    merge: "CLEAN",
    updatedMin: 26 * 60,
    body: "Reads `release.yml` when it exists, else `legacy.yml`.",
    files: [{ path: "src/config.ts", additions: 42, deletions: 9 }],
    passed: ["lint", "test"],
    draftPhrase: "build release targets from release.yml",
  },
  {
    repo: "acme/search",
    number: 77,
    title: "ACME-398: scale the indexer on queue depth, not CPU",
    branch: "sam/ACME-398-queue-depth",
    state: "OPEN",
    review: "APPROVED",
    checks: "SUCCESS",
    merge: "CLEAN",
    updatedMin: 170,
    body: "The indexer is IO-bound, so CPU never crosses the threshold. This scales it on the queue depth.",
    files: [{ path: "deploy/indexer-hpa.yaml", additions: 12, deletions: 6 }],
    passed: ["lint", "test", "helm-lint"],
    reviews: [{ author: "alex", state: "APPROVED", body: "", minAgo: 200 }],
    draftPhrase: "scale the search indexer on queue depth instead of CPU",
  },
  {
    repo: "acme/web-platform",
    number: 181,
    title: "ACME-421: point review bot sessions at acme/web-platform",
    branch: "sam/ACME-421-review-bot-org",
    state: "OPEN",
    review: "REVIEW_REQUIRED",
    checks: "FAILURE",
    merge: "UNSTABLE",
    updatedMin: 120,
    body: "**Do not merge until the review bot can see the new org.** The bot cannot clone a repo that its GitHub App cannot see. Jordan must approve the GitHub App on `acme` first.\n\n### What changes\nThe `POST /api/review-bot/create-session` route sends `repos: [\"acme/web-platform\"]` to the bot, not `acme/legacy-platform`. All four callers use this one route.\n\n### Out of scope\nOther admin-console routes still name `acme/legacy-platform`. They move in a separate change.",
    files: [
      { path: "apps/admin-console/src/routes/review-bot.ts", additions: 1, deletions: 1 },
      { path: "apps/admin-console/test/review-bot.test.ts", additions: 6, deletions: 2 },
    ],
    failed: [
      {
        name: "unit-tests",
        job: 9001,
        log: "2026-10-12T10:01:02.0000000Z > admin-console@1.0.0 test\n2026-10-12T10:01:09.0000000Z  FAIL  test/review-bot.test.ts > create-session > sends the new org\n2026-10-12T10:01:09.0000000Z AssertionError: expected [ 'acme/legacy-platform' ] to deeply equal [ 'acme/web-platform' ]\n2026-10-12T10:01:09.0000000Z  ❯ test/review-bot.test.ts:41:32\n2026-10-12T10:01:10.0000000Z  Test Files  1 failed | 23 passed (24)\n2026-10-12T10:01:10.0000000Z ##[error]Process completed with exit code 1.",
      },
    ],
    passed: ["lint", "typecheck", "build", "e2e-smoke"],
    reviews: [{ author: "alex", state: "COMMENTED", body: "One question on the test fixture.", minAgo: 100 }],
    comments: [
      { author: "jordan", body: "I can approve the GitHub App install on acme this afternoon.", minAgo: 90 },
      { author: "sam", body: "Thanks! I will hold the merge until then.", minAgo: 85 },
    ],
    threads: [{ path: "apps/admin-console/test/review-bot.test.ts", line: 41, comments: [{ author: "alex", body: "The fixture still builds the old org name, so this test cannot pass. Use the constant from the route?", minAgo: 100 }] }],
    draftPhrase: "point the review bot's sessions at the new GitHub org",
  },
  {
    repo: "acme/docs-site",
    number: 58,
    title: "ACME-415: run the docs build against the API mock in CI",
    branch: "sam/ACME-415-api-mock",
    state: "OPEN",
    review: "CHANGES_REQUESTED",
    checks: "PENDING",
    merge: "BLOCKED",
    updatedMin: 240,
    body: "CI cannot reach the Staging API, so the docs build uses the API mock there.",
    files: [{ path: ".github/workflows/docs.yml", additions: 8, deletions: 2 }],
    passed: ["lint"],
    reviews: [{ author: "jordan", state: "CHANGES_REQUESTED", body: "Keep the real API for the nightly build, so we still see a broken endpoint.", minAgo: 250 }],
    draftPhrase: "build the docs against the API mock in CI",
  },
];

export const prUrl = (p: DemoPr) => `https://github.com/${p.repo}/pull/${p.number}`;

// ---- drafts that the fake agent returns -------------------------------------------------

/** The newest next-steps draft of each ticket. */
export const NEXT_STEPS: Record<string, { minAgo: number; text: string }> = {
  "ACME-412": {
    minAgo: 55,
    text: "**State:** PR release-bot#239 is merged and live on Staging (`4.9.20`), but the Staging smoketest was blocked: the release bot app is private to `acme-demo`.\n\n**Next steps:**\n1. Sam authorizes the `gh` token for the `acme-demo` org at github.com/settings/tokens. This removes the blocker.\n2. An agent runs the Staging smoketest plan again in `acme-demo/release-smoke`.\n3. Sam asks Alex to choose: skip or fail repos with no `release.yml`.\n\n**Blockers:** The `gh` token has no `acme-demo` org access.\n**Gaps:** None.",
  },
  "ACME-398": {
    minAgo: 160,
    text: "**State:** PR search#77 is approved and green. The deploy freeze ends at 18:00.\n\n**Next steps:**\n1. An agent merges search#77 after 18:00.\n2. An agent confirms the indexer deploy in Staging.\n\n**Blockers:** None.",
  },
  "ACME-421": {
    minAgo: 110,
    text: "**State:** PR web-platform#181 has red CI: the test fixture still names the old org.\n\n**Next steps:**\n1. An agent fixes the test fixture on web-platform#181 and pushes.\n2. Jordan approves the GitHub App install on `acme`.\n3. Sam requests a review in #team-reviews.\n\n**Blockers:** The GitHub App is not installed on `acme` yet.",
  },
  "ACME-415": {
    minAgo: 230,
    text: "**State:** Jordan asked for changes on docs-site#58: keep the real API for the nightly build.\n\n**Next steps:**\n1. An agent adds a flag that keeps the real API for the nightly build.\n2. Sam moves the ticket to In Review.\n\n**Blockers:** None.",
  },
  "ACME-430": {
    minAgo: 25,
    text: "**State:** The v2.3 draft has 14 items; four are internal refactors.\n\n**Next steps:**\n1. Sam says if the four refactors stay.\n2. An agent opens a PR with the release notes.\n\n**Blockers:** None.",
  },
  "ACME-433": {
    minAgo: 3 * 24 * 60,
    text: "**State:** The runbook still says to restart the bot by hand. The ticket is two days overdue.\n\n**Next steps:**\n1. An agent rewrites the restart section of the runbook for the new auto-restart.\n2. Sam sets a new due date.\n\n**Blockers:** None.",
  },
  "ACME-77": {
    minAgo: 4 * 24 * 60,
    text: "**State:** The move plan is in docs/cluster-move.md. No work since.\n\n**Next steps:**\n1. An agent moves the search API to the new cluster first.\n2. Sam schedules the indexer move with Alex.\n\n**Blockers:** None.",
  },
};

/** The kanban card label of each ticket's top step. A move step needs no label: the server writes it. */
export const STEP_LABELS: Record<string, string> = {
  "ACME-412": "Agent prepares the token setup steps",
  "ACME-398": "Agent merges search#77 after the freeze",
  "ACME-421": "Agent fixes the test fixture and pushes",
  "ACME-415": "Agent adds the nightly real-API flag",
  "ACME-430": "Agent lists the four refactors to cut",
  "ACME-433": "Agent rewrites the runbook restart section",
  "ACME-77": "Agent moves the search API first",
};

export const NOTES: Record<string, { minAgo: number; body: string }[]> = {
  "ACME-412": [
    { minAgo: 23 * 60, body: "Alex is OK to ship to prod after a green Staging smoketest." },
    { minAgo: 70, body: "I have admin on acme-demo, so I can authorize the token myself." },
  ],
};

export const DOCUMENT = {
  ticket: "ACME-412",
  title: "How the release bot picks its config file",
  body: "The bot reads `release.yml` first, and falls back to `legacy.yml`.\n\n```mermaid\nflowchart LR\n  merge[Merge to main] --> bot[Release bot]\n  bot --> q{release.yml?}\n  q -- yes --> new[Build targets from release.yml]\n  q -- no --> old[Build targets from legacy.yml]\n```\n\nA repo with neither file gets no release, and the bot logs a warning.",
};

export const WIKI: Record<string, string> = {
  "services/Release bot.md":
    "---\ntype: service\ntags: [release, ci]\naliases: [release-bot]\n---\n# Release bot\n\nBuilds a release for each merge to `main`. It reads `release.yml`, else `legacy.yml`.\n\n- Owner: the platform team\n- Deploys: Staging on merge, prod by hand\n- Runbook: [[Restart the release bot]]\n- Known issue: [[Staging GitHub App is private]]\n\n```mermaid\nflowchart LR\n  gh[GitHub merge] --> bot[Release bot] --> rel[GitHub release]\n```\n",
  "runbooks/Restart the release bot.md": "---\ntype: runbook\ntags: [release, on-call]\n---\n# Restart the release bot\n\nThe bot restarts itself after three failed releases. To restart it by hand, redeploy the `release-bot` app.\n\nSee [[Release bot]].\n",
  "gotchas/Staging GitHub App is private.md": "---\ntype: gotcha\ntags: [github, staging]\n---\n# Staging GitHub App is private\n\nThe Staging [[Release bot]] app is installed only on `acme-demo`. A token with no access to that org gets a 404, not a 403.\n",
  "services/Search.md": "---\ntype: service\ntags: [search]\n---\n# Search\n\nThe search API and its indexer. The indexer scales on queue depth.\n",
  "decisions/Use release.yml.md": "---\ntype: decision\nstatus: stale\n---\n# Use release.yml\n\nNew repos use `release.yml`. Old repos keep `legacy.yml` until they move.\n",
};
