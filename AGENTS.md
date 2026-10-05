# agent-dash: agent rules

- **Merge your own PRs here at once.** This repo (`pgragg/agent-dash`) is Piper's personal tool, and no one reviews it. After you open a PR into `main` and the checks pass (`pnpm typecheck && pnpm test && pnpm build`), merge it yourself with `gh pr merge <n> --merge`, then `git push origin --delete <branch>` (`--delete-branch` fails when `main` is checked out in another worktree). Do not wait for a review, and do not ask first. This overrides the global "ask before merges" rule, for this repo only.
- Work in a `git worktree` off `origin/main`, not in this checkout: other agents use it at the same time.
