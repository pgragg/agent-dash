#!/usr/bin/env bash
# Ship merged work to the live dashboard (port 7777): merge the PR if it is still open,
# pull main into the live folder, build, restart the server, and prove that the page changed.
#
#   scripts/ship.sh [<pr-number>]
#
# Each step must succeed before the next one runs. A merge that GitHub blocks once made an
# agent build the old main and report it as shipped, so the script checks the merge commit
# is in the live folder before it builds, and checks the served page after the restart.
#
# Env: AGENT_DASH_PORT (default 7777), AGENT_DASH_LOG (default /tmp/agent-dash.log).
set -euo pipefail

pr="${1:-}"
port="${AGENT_DASH_PORT:-7777}"
log="${AGENT_DASH_LOG:-/tmp/agent-dash.log}"
repo=pgragg/agent-dash

die() { echo "ship: $*" >&2; exit 1; }
step() { echo "ship: $*"; }

# The live folder is the checkout that holds .git. Worktrees point back to it.
live="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
cd "$live"
[[ "$(git branch --show-current)" == main ]] || die "$live is not on main"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "$live has uncommitted changes"

if [[ -n "$pr" ]]; then
  state="$(gh pr view "$pr" -R "$repo" --json state --jq .state)"
  if [[ "$state" == OPEN ]]; then
    # --admin skips the required checks, so never merge while a check is red or pending.
    bad="$(gh pr checks "$pr" -R "$repo" --json name,bucket --jq '.[] | select(.bucket != "pass" and .bucket != "skipping") | "\(.name)=\(.bucket)"')"
    [[ -z "$bad" ]] || die "PR #$pr has checks that are not green: $bad"
    step "merging PR #$pr"
    branch="$(gh pr view "$pr" -R "$repo" --json headRefName --jq .headRefName)"
    gh pr merge "$pr" -R "$repo" --merge --admin
    state="$(gh pr view "$pr" -R "$repo" --json state --jq .state)"
    [[ "$state" == MERGED ]] || die "PR #$pr is $state after the merge"
    git push -q origin --delete "$branch" || echo "ship: could not delete branch $branch (delete it by hand)" >&2
  fi
  [[ "$state" == MERGED ]] || die "PR #$pr is $state, not MERGED"
  merge_sha="$(gh pr view "$pr" -R "$repo" --json mergeCommit --jq .mergeCommit.oid)"
fi

step "pulling main"
before="$(git rev-parse HEAD)"
git pull -q --ff-only origin main
if [[ -n "$pr" ]]; then
  git merge-base --is-ancestor "$merge_sha" HEAD || die "merge commit $merge_sha of PR #$pr is not in main after the pull"
fi

if ! git diff --quiet "$before" HEAD -- pnpm-lock.yaml; then
  step "lockfile changed: pnpm install"
  pnpm install --frozen-lockfile
fi

step "building"
pnpm build

old_pid="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [[ -n "$old_pid" ]]; then
  step "stopping server pid $old_pid"
  parent="$(ps -o ppid= -p "$old_pid" | tr -d ' ')"
  kill "$old_pid"
  # `pnpm start` is the parent. Stop it too, so no orphan restarts the old code.
  if [[ -n "$parent" && "$parent" != 1 ]] && ps -o command= -p "$parent" | grep -q 'pnpm'; then
    kill "$parent" 2>/dev/null || true
  fi
  for _ in $(seq 1 40); do lsof -t -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done
  ! lsof -t -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || die "port $port is still in use after the stop"
fi

step "starting server (log: $log)"
(AGENT_DASH_PORT="$port" nohup pnpm start >>"$log" 2>&1 &)
for _ in $(seq 1 60); do curl -fs -o /dev/null --max-time 1 "http://127.0.0.1:$port/" && break; sleep 0.5; done

new_pid="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
[[ -n "$new_pid" ]] || die "server did not start; see $log"
[[ "$new_pid" != "$old_pid" ]] || die "server pid did not change ($new_pid)"
served="$(curl -fs --max-time 5 "http://127.0.0.1:$port/")" || die "server does not answer on port $port"
[[ "$served" == "$(cat web/dist/index.html)" ]] || die "the served page is not the build in web/dist"

step "shipped $(git rev-parse --short HEAD) on port $port (pid $new_pid)"
