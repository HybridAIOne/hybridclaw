---
name: github-pr-workflow
description: Create branches, commit and push changes, open or update GitHub pull requests, handle CI, and merge safely.
user-invocable: true
metadata:
  hybridclaw:
    category: development
    short_description: "GitHub PR workflow."
    tags:
      - engineering
      - github
      - pull-requests
      - ci
    related_skills:
      - code-review
      - feature-planning
---
# GitHub PR Workflow

Use this skill for the end-to-end pull request loop from branch creation through
merge readiness.

## Default Sequence

0. Verify GitHub CLI authentication if the workflow will use `gh`.
1. Sync the base branch.
2. Create a focused branch for one change.
3. Implement and validate locally.
4. Commit with a clear message.
5. Push and open or update the PR.
6. Check CI and fix failures.
7. Address review feedback.
8. Merge only when the branch is green and approved.

## Core Commands

### Verify GitHub CLI Auth

```bash
gh auth status
```

Run this before any git or PR workflow steps that depend on `gh`. If it fails,
fix authentication first so the workflow does not stop later during `gh pr create`,
`gh pr checks`, or other PR commands.

### Prepare the Branch

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b feat/short-description
```

Use the repository's actual base branch if it is not `main`.

### Commit Clearly

```bash
git status --short
git add path/to/file.ts tests/path/to/file.test.ts
git commit -m "feat: short summary"
```

Keep commits scoped and explain user-visible intent in the subject line.

### Push and Open the PR

```bash
git push -u origin HEAD
gh pr create --fill
```

When `--fill` is not enough, make the body explicit with:

- summary
- test plan
- risks or rollout notes
- linked issue or ticket

Useful variants:

```bash
gh pr create --draft
gh pr create --base main --title "feat: short summary" --body-file /tmp/pr-body.md
gh pr view --web
```

If `gh` is unavailable, complete the local git steps and use the GitHub UI for
PR-specific actions.

## CI and Merge Readiness

Check status after every push:

```bash
gh pr checks
gh pr checks --watch
gh run list --branch "$(git branch --show-current)" --limit 5
gh run view <run-id> --log-failed
```

When a check fails:

1. inspect the failing job or logs
2. reproduce locally if possible
3. fix the smallest confirmed problem
4. rerun targeted validation
5. push again and re-check CI

Do not merge red CI unless the user explicitly accepts that risk.

## Review Feedback Loop

Use the PR conversation as the source of truth:

```bash
gh pr view 123 --comments
gh pr comment 123 --body "Addressed the failing migration path."
gh pr review 123 --comment --body "Applied the requested cleanup."
```

When feedback arrives:

- group related comments into one fix pass when practical
- mention what changed, not just that it is done
- rerun the checks most likely to regress
- keep follow-up commits small and labeled by intent

## Merge Options

Use the repository's preferred merge style:

```bash
gh pr merge 123 --squash
gh pr merge 123 --merge
gh pr merge 123 --rebase
```

Before merging, verify:

- CI is green
- required reviewers approved
- the PR description still matches the implementation
- no unresolved review threads remain if the repo treats them as blockers

## Working Rules

- Prefer small PRs over broad mixed-scope branches.
- Keep the PR body current when scope changes.
- Do not hide risky follow-up work in "later" comments; put it in the PR body or
  linked issue.
- If a change needs multiple dependent PRs, make the stack explicit.
- When CI is noisy or flaky, call that out instead of pretending the branch is
  stable.
