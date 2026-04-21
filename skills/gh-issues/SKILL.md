---
name: gh-issues
description: Fetch GitHub issues, delegate focused fixes, open pull requests, and follow up on actionable PR review comments.
user-invocable: true
disable-model-invocation: false
requires:
  bins:
    - gh
    - git
metadata:
  hybridclaw:
    category: development
    short_description: "GitHub issue auto-fix workflow."
    tags:
      - engineering
      - github
      - issues
      - pull-requests
      - delegation
    related_skills:
      - github-pr-workflow
      - code-review
    install:
      - id: brew
        kind: brew
        formula: gh
        bins:
          - gh
        label: "Install GitHub CLI (brew)"
---
# GitHub Issues

Use this skill for `/gh-issues` requests that fetch GitHub issues, assign
focused subagents to implement fixes, open pull requests, or address actionable
review comments on issue-fix PRs.

## Inputs

Parse the arguments after `/gh-issues`.

Positional:

- `owner/repo`: source repository. If omitted, infer it from
  `git remote get-url origin`.

Flags:

- `--label <label>`: filter issues by label.
- `--milestone <milestone>`: filter issues by milestone title.
- `--assignee <assignee>`: filter by assignee. Use `@me` for the authenticated
  GitHub user.
- `--state <open|closed|all>`: default `open`.
- `--limit <n>`: default `10`.
- `--fork <owner/repo>`: push branches to a fork while opening PRs against the
  source repository.
- `--dry-run`: list matching issues only.
- `--yes`: process listed issues without asking for another confirmation.
- `--reviews-only`: skip issue fetching and only handle PR review comments.
- `--watch <minutes>`: schedule a recurring follow-up instead of sleeping.
- `--model <model>`: optional model override for delegated tasks.

Derived values:

- `SOURCE_REPO`: issue and PR target repository.
- `PUSH_REPO`: `--fork` value, otherwise `SOURCE_REPO`.
- `PUSH_REMOTE`: `fork` when `--fork` is used, otherwise `origin`.
- `FORK_MODE`: true when `--fork` is used.

If required information is missing, stop with the smallest specific request
needed to continue.

## Authentication

Prefer GitHub CLI authentication.

```bash
gh auth status
```

If that fails and `GH_TOKEN` is set, retry commands with `GH_TOKEN` in the
environment. If authentication still fails, stop and ask the user to run
`gh auth login` or provide `GH_TOKEN`.

Do not print tokens, embed tokens in final responses, or store tokens in files.

## Fetch Issues

Use `gh issue list` so pull requests are excluded by default.

```bash
gh issue list --repo "$SOURCE_REPO" --state open --limit 10 \
  --json number,title,labels,assignees,url,body
```

Add optional filters only when present:

- `--label "$LABEL"`
- `--milestone "$MILESTONE"`
- `--assignee "$ASSIGNEE"` after resolving `@me` with
  `gh api user --jq .login`

Display matching issues as a compact markdown table with number, title, labels,
and assignees. If `--dry-run` is set, stop after the table.

If no issues match, report that directly. Do not delegate an empty batch.

## Confirmation

Unless `--yes` is set, ask which issues to process:

- `all`
- comma-separated issue numbers
- `cancel`

After the user chooses, continue only with selected issue numbers.

## Preflight

Run these checks before delegating fixes:

1. Check the working tree.

   ```bash
   git status --porcelain
   ```

   If it is dirty, explain that delegated fixes should start from committed
   state and ask whether to continue. Do not stage or commit unrelated changes.

2. Record the base branch.

   ```bash
   git rev-parse --abbrev-ref HEAD
   ```

3. Verify remotes.

   ```bash
   git ls-remote --exit-code origin HEAD
   ```

   In fork mode, ensure a `fork` remote exists for `PUSH_REPO`; add it only if
   missing.

4. Skip issues that already have an open PR from the intended branch.

   ```bash
   gh pr list --repo "$SOURCE_REPO" --state open \
     --head "fix/issue-$ISSUE_NUMBER" \
     --json number,url,headRefName,headRepositoryOwner \
     --jq ".[] | select(.headRepositoryOwner.login == \"$PUSH_OWNER\")"
   ```

5. Skip issues whose intended branch already exists in `PUSH_REPO`.

   ```bash
   gh api "repos/$PUSH_REPO/branches/fix/issue-$ISSUE_NUMBER" --silent
   ```

Only delegate remaining issues.

## Delegate Fixes

Use the `delegate` tool in `parallel` mode for up to 6 independent issues at a
time. If there are more than 6 selected issues, process them in batches after
the previous batch reports back. Do not poll or sleep for delegated completion.

Each delegated task must be self-contained and include:

- source repo, push repo, fork mode, push remote, and base branch
- issue number, title, URL, labels, assignees, and body
- expected branch name: `fix/issue-<number>`
- instruction to open a PR linked to the issue
- exact output format requested from the subagent
- model override when `--model` was provided

Use this task shape:

```text
You are a focused issue-fix subagent. Fix exactly one GitHub issue and open a PR.

Repository: {SOURCE_REPO}
Push repository: {PUSH_REPO}
Fork mode: {FORK_MODE}
Push remote: {PUSH_REMOTE}
Base branch: {BASE_BRANCH}
Branch: fix/issue-{NUMBER}

Issue #{NUMBER}: {TITLE}
URL: {URL}
Labels: {LABELS}
Assignees: {ASSIGNEES}
Body:
{BODY}

Workflow:
1. Confirm the issue is actionable. If confidence is below 7/10, stop and
   report why instead of guessing.
2. Create branch `fix/issue-{NUMBER}` from `{BASE_BRANCH}`.
3. Find the smallest relevant code or docs change.
4. Implement only the issue fix.
5. Run targeted tests or explain why no targeted test exists.
6. Stage only your changes and commit with:
   `fix: {SHORT_DESCRIPTION}`

   Include `Fixes {SOURCE_REPO}#{NUMBER}` in the commit body.
7. Push to `{PUSH_REMOTE}` and open a pull request against `{SOURCE_REPO}`.
8. Return: PR URL, files changed, tests run, skipped checks, and any caveats.

Constraints:
- Do not modify unrelated files.
- Do not force-push.
- Do not commit secrets, local config, or personal data.
- If the working tree contains unrelated changes, leave them untouched.
```

When delegated results return, present a compact summary table:

| Issue | Status | PR | Notes |
| --- | --- | --- | --- |

Statuses should be `PR opened`, `Skipped`, `Failed`, or `Needs manual review`.

## Review-Only Mode

When `--reviews-only` is set, find open issue-fix PRs:

```bash
gh pr list --repo "$SOURCE_REPO" --state open \
  --json number,title,url,headRefName,body \
  --jq '.[] | select(.headRefName | startswith("fix/issue-"))'
```

For each candidate PR, inspect review sources:

```bash
gh pr view "$PR_NUMBER" --repo "$SOURCE_REPO" \
  --json number,title,url,body,reviews,comments,reviewDecision
gh api "repos/$SOURCE_REPO/pulls/$PR_NUMBER/comments"
```

Treat comments as actionable when they request a concrete change, report a bug,
identify a failing case, or come from a `CHANGES_REQUESTED` review. Skip pure
approvals, CI summaries, "LGTM", and comments authored by the bot itself.

Display a table of PRs with actionable comments. Unless `--yes` is set, ask
which PRs to address.

## Delegate Review Fixes

Use `delegate` in `parallel` mode for up to 6 PRs at a time. Each task must
include the PR URL, branch, source repo, push repo, and a JSON or markdown list
of actionable comments with author, body, path, line, and comment URL when
available.

Use this task shape:

```text
You are a focused PR review-fix subagent. Address actionable review feedback on
one pull request.

Repository: {SOURCE_REPO}
Push repository: {PUSH_REPO}
Push remote: {PUSH_REMOTE}
PR #{PR_NUMBER}: {PR_URL}
Branch: {BRANCH}

Actionable comments:
{COMMENTS}

Workflow:
1. Fetch and checkout `{BRANCH}` from `{PUSH_REMOTE}`.
2. Read every actionable comment and group changes by file.
3. Implement only the requested review fixes.
4. Run targeted tests or explain why none apply.
5. Commit with `fix: address review feedback on PR #{PR_NUMBER}`.
6. Push the branch.
7. Reply to addressed comments with a brief summary and commit SHA.
8. Return: comments addressed, comments skipped, commit SHA, files changed,
   tests run, and manual follow-ups.

Constraints:
- Do not force-push.
- Do not rewrite unrelated PR history.
- If comments conflict, address the newest concrete request and flag the
  conflict.
```

## Watch Mode

If `--watch <minutes>` is set, do not sleep in the active turn. Use the `cron`
tool to schedule a recurring follow-up prompt that reinvokes this skill with the
same repository, filters, and `--reviews-only` when appropriate. Include enough
context in the scheduled prompt to continue safely, but do not include issue
bodies, review bodies, tokens, or subagent transcripts.

## Safety Rules

- Keep branches scoped to one issue or one PR review batch.
- Prefer targeted validation over full-suite runs unless the touched area is
  broad.
- Never hide skipped checks; include them in the summary.
- Never weaken repository security policy, approval rules, or CI configuration
  to make an issue easier to close.
- If the issue is vague, too large, or not reproducible, report analysis and
  leave it for manual triage instead of opening a speculative PR.
