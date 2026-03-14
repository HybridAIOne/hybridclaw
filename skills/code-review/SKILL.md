---
name: code-review
description: Use this skill when the user wants a code review, PR review, diff audit, bug-risk scan, test-gap check, or structured findings on a change set.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - engineering
      - review
      - quality
      - github
    related_skills:
      - github-pr-workflow
      - feature-planning
---

# Code Review

Use this skill to review local changes or an existing GitHub pull request for
correctness, regressions, maintainability, security, and missing tests.

## Review Order

1. Establish scope with `git status --short`, `git diff --stat`, and
   `git diff --name-only`.
2. Read the changed files, not just the diff, before judging behavior.
3. Run targeted validation when it exists: tests, typecheck, lint, build, or
   repo-specific checks.
4. Present findings ordered by severity, then open questions, then a brief
   summary.

## Primary Workflows

### Local Branch Review

Use local git state when the change is in the current checkout:

```bash
git status --short
git diff --stat
git diff --name-only
git diff --staged
git diff <base-branch>...HEAD
git log --oneline <base-branch>..HEAD
```

Replace `<base-branch>` with the repository's actual review base branch.

### GitHub PR Review

Use `gh` when the review target is an open pull request:

```bash
gh pr view 123
gh pr diff 123
gh pr checkout 123
gh pr view 123 --comments
```

After checking out the PR branch, review it the same way as a local branch and
run the relevant repo checks before leaving comments.

## What to Look For

Prioritize issues that change behavior or raise delivery risk:

- incorrect logic or broken edge cases
- state, data, or migration regressions
- auth, permission, or secret-handling mistakes
- missing validation, retries, or error handling
- flaky or incomplete tests
- risky coupling, hidden side effects, or cleanup gaps

Treat pure style comments as low priority unless the user explicitly asks for a
style review.

## Review Output

Default to this structure:

1. Findings
2. Open questions or assumptions
3. Brief summary

For each finding:

- cite the file and the most relevant line or function
- explain the concrete failure mode or risk
- describe the user-visible impact when possible
- note the missing test or validation that would catch it

If there are no findings, say that explicitly and mention any residual risk such
as unrun integration tests or unverified deployment paths.

## Working Rules

- Prefer evidence from code and test behavior over speculation.
- Distinguish confirmed defects from probable risks and from optional
  suggestions.
- Review generated or vendored files by tracing back to their source inputs when
  practical.
- Do not bury the most severe issue behind minor nits.
- When a diff is large, identify the riskiest files first and focus depth there.

## Useful Checks

Use targeted searches when helpful:

```bash
git diff <base-branch>...HEAD | rg "console\\.log|TODO|FIXME|HACK|debugger"
git diff <base-branch>...HEAD | rg "<<<<<<<|=======|>>>>>>>"
git diff <base-branch>...HEAD | rg -i "password|secret|token|api[_-]?key|private[_-]?key"
```

Prefer repo-native test commands over broad guesses. Run the smallest check set
that can confirm or disprove a suspected issue.
