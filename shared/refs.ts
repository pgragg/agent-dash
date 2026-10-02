/** Ids that the page and the server share for agent-dash objects. See web/src/routes.ts for the full list. */

/** "pr:owner/repo/123" for a GitHub PR URL: the PRs view's id for it. */
export function prRef(url: string): string | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? `pr:${m[1]}/${m[2]}/${m[3]}` : null;
}
