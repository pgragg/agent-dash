/** The demo's `gh`: the answers that agent-dash reads, built from the fictional PRs in world.ts. */
import { ago, type DemoPr, GH_LOGIN, PRS, prUrl } from "./world.ts";

const now = Number(process.env.DEMO_NOW ?? Date.now());
const args = process.argv.slice(2);
const field = (name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const out = (v: unknown) => process.stdout.write(typeof v === "string" ? `${v}\n` : JSON.stringify(v));

const author = (login: string) => ({ login, __typename: "User" });
const url = (p: DemoPr, frag: string) => `${prUrl(p)}#${frag}`;

function contexts(p: DemoPr) {
  return [
    ...(p.failed ?? []).map((f) => ({ name: f.name, status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `https://github.com/${p.repo}/actions/runs/1/job/${f.job}`, databaseId: f.job, checkSuite: { app: { slug: "github-actions" } } })),
    ...p.passed.map((name) => ({ name, status: "COMPLETED", conclusion: p.checks === "PENDING" ? null : "SUCCESS", detailsUrl: null, databaseId: null, checkSuite: { app: { slug: "github-actions" } } })),
  ];
}

function node(p: DemoPr) {
  return {
    url: prUrl(p),
    number: p.number,
    title: p.title,
    state: p.state,
    isDraft: !!p.draft,
    body: p.body,
    baseRefName: "main",
    headRefName: p.branch,
    reviewDecision: p.review,
    mergeable: "MERGEABLE",
    mergeStateStatus: p.merge,
    additions: p.files.reduce((n, f) => n + f.additions, 0),
    deletions: p.files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: p.files.length,
    updatedAt: ago(now, p.updatedMin),
    author: author(GH_LOGIN),
    repository: { nameWithOwner: p.repo },
    reviewRequests: { nodes: p.review === "REVIEW_REQUIRED" ? [{ requestedReviewer: { login: "alex" } }] : [] },
    latestReviews: { nodes: (p.reviews ?? []).map((r) => ({ author: author(r.author), state: r.state })) },
    files: { nodes: p.files },
    reviews: { nodes: (p.reviews ?? []).map((r, i) => ({ author: author(r.author), state: r.state, body: r.body, submittedAt: ago(now, r.minAgo), url: url(p, `pullrequestreview-${i + 1}`) })) },
    comments: { nodes: (p.comments ?? []).map((c, i) => ({ author: author(c.author), body: c.body, createdAt: ago(now, c.minAgo), url: url(p, `issuecomment-${i + 1}`) })) },
    reviewThreads: {
      nodes: (p.threads ?? []).map((t, i) => ({
        isResolved: false,
        isOutdated: false,
        path: t.path,
        line: t.line,
        originalLine: t.line,
        comments: { nodes: t.comments.map((c, j) => ({ author: author(c.author), body: c.body, createdAt: ago(now, c.minAgo), url: url(p, `discussion_r${i + 1}${j}`) })) },
      })),
    },
    commits: { nodes: [{ commit: { committedDate: ago(now, p.updatedMin + 5), statusCheckRollup: { state: p.checks, contexts: { nodes: contexts(p) } } } }] },
  };
}

const [cmd, sub] = args;
if (cmd === "auth") {
  out("Logged in to github.com account sam");
} else if (cmd === "api" && sub === "user") {
  out(GH_LOGIN);
} else if (cmd === "api" && sub === "graphql") {
  const q = field("q");
  if (q !== undefined) {
    const key = q.match(/in:title "([^"]+)"/)?.[1];
    const prs = key ? PRS.filter((p) => p.title.includes(key)) : PRS;
    out({ data: { search: { nodes: prs.map(node) } } });
  } else {
    const p = PRS.find((x) => x.repo === `${field("owner")}/${field("name")}` && x.number === Number(field("number")));
    out({ data: { repository: { pullRequest: p ? node(p) : null } } });
  }
} else if (cmd === "api" && args.some((a) => /\/actions\/jobs\/\d+\/logs$/.test(a))) {
  const job = Number(args.find((a) => a.endsWith("/logs"))!.split("/").at(-2));
  const log = PRS.flatMap((p) => p.failed ?? []).find((f) => f.job === job)?.log;
  if (!log) process.exit(1);
  out(log);
} else if (cmd === "pr" && sub === "view") {
  const p = PRS.find((x) => prUrl(x) === args[2]);
  if (!p) process.exit(1);
  out({ body: p.body, files: p.files.map((f) => ({ path: f.path })) });
} else {
  process.stderr.write(`demo gh: no fixture for: gh ${args.join(" ").slice(0, 200)}\n`);
  process.exit(1);
}
