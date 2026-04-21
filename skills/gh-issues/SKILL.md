---
name: gh-issues
description: "Process GitHub issues as an automation queue: /gh-issues lists and filters issues, confirms selected issue numbers, deduplicates fix/issue-* work, delegates one focused PR per issue, and can monitor issue-fix PR review feedback. Use this instead of general PR workflow tools only when the entry point is a GitHub issue list or issue-fix queue."
user-invocable: true
disable-model-invocation: false
requires:
  bins:
    - git
metadata:
  hybridclaw:
    category: development
    short_description: "GitHub issue queue automation."
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
      - id: gh
        kind: brew
        formula: gh
        bins: ["gh"]
        label: "Install GitHub CLI (brew)"
---
# GitHub Issues

You are an issue queue orchestrator. Follow the phases in order. Do not run
processing preflight before the user has selected issues.

Live data invariant: every issue-list or "no issues matched" response must be
based on a successful GitHub data tool call made in the current turn. Never
reuse issue tables, issue numbers, labels, or "no matches" results from memory,
conversation history, session search, cached summaries, or previous turns. If no
current-turn GitHub data call succeeds, report the fetch failure instead of
answering from stale context.

Use this skill for `/gh-issues` requests that start from a GitHub issue list,
batch issue filters, `fix/issue-*` branch automation, issue-fix PR review
monitoring, or scheduled issue queue follow-up.

Do not use this skill for ordinary branch, commit, push, PR, CI, or review work
that starts from the current branch or a known PR. Use a GitHub PR workflow or
code-review skill for those.

## Phase 1 - Parse Arguments

Parse the arguments after `/gh-issues`.

Positional:

- `owner/repo`: source repository. If omitted, infer it from
  `git remote get-url origin`; if that is unavailable, ask for `owner/repo`.
  If `owner/repo` is provided explicitly, do not run any local git discovery
  during parsing or issue listing. Local checkout checks belong only to Phase 4
  after issue selection.

Flags:

| Flag | Default | Description |
| --- | --- | --- |
| `--label <label>` | none | Filter by label. |
| `--limit <n>` | `10` | Max issues to fetch per poll. |
| `--milestone <milestone>` | none | Filter by milestone title. |
| `--assignee <assignee>` | none | Filter by assignee; resolve `@me` with `gh api user --jq .login`. |
| `--state <open\|closed\|all>` | `open` | Issue state. |
| `--fork <owner/repo>` | none | Push branches to a fork while PRs target the source repo. |
| `--watch` | false | Fetch the issue list normally, then schedule recurring issue and review follow-up after the first confirmed run. |
| `--interval <minutes>` | `5` | Watch interval; only valid with `--watch`. |
| `--cron` | false | Recurring-run mode: process at most one eligible item and exit. |
| `--dry-run` | false | Fetch and display issues only. |
| `--yes` | false | Process listed issues without another confirmation. |
| `--reviews-only` | false | Skip issue fetching and process issue-fix PR review feedback. |
| `--model <model>` | none | Optional model override for delegated tasks. |
| `--notify-channel <target>` | none | Optional HybridClaw message target for final summaries only. |

Derived values:

- `SOURCE_REPO`: issue and PR target repository.
- `PUSH_REPO`: `--fork` value, otherwise `SOURCE_REPO`.
- `PUSH_OWNER`: owner portion of `PUSH_REPO`.
- `PUSH_REMOTE`: `fork` when `--fork` is used, otherwise `origin`.
- `FORK_MODE`: true when `--fork` is used.
- `SOURCE_REPO_SLUG`: `SOURCE_REPO` with `/` replaced by `-`.

Mode routing:

- If `--reviews-only` is set, run authentication, then jump to Phase 6.
- If `--cron` is set, force `--yes`.
- If `--watch` is set, use `--interval`, defaulting to 5 minutes. Do not skip
  issue fetching or confirmation. The first watch turn follows Phases 2 and 3
  like a normal run.

## Phase 2 - Authenticate And Fetch Issues

GitHub CLI is preferred but optional. First check whether it exists:

```bash
command -v gh
```

If `gh` exists, prefer GitHub CLI authentication:

```bash
gh auth status
```

If `gh` is unavailable or authentication fails, use the GitHub REST API through
the `http_request` tool with `bearerSecretName: "GH_TOKEN"`. The gateway resolves
`GH_TOKEN` from the encrypted secret store; do not ask the shell for `GH_TOKEN`,
do not echo tokens, and do not use `curl` for authenticated GitHub API calls. If
neither `gh` auth nor stored secret `GH_TOKEN` works, ask the user to run
`gh auth login` or store a GitHub token with `/secret set GH_TOKEN <token>`.

When not in `--reviews-only`, fetch issues with a current-turn GitHub data call.
Primary `gh` path:

```bash
gh issue list --repo "$SOURCE_REPO" --state "$STATE" --limit "$LIMIT" \
  --json number,title,labels,assignees,url,body
```

Add optional filters only when present:

- `--label "$LABEL"`
- `--milestone "$MILESTONE"`
- `--assignee "$ASSIGNEE"` after resolving `@me`

API fallback path with `gh` still available:

```bash
gh api "repos/$SOURCE_REPO/issues" \
  -f state="$STATE" -f per_page="$LIMIT"
```

API fallback path without `gh`: call `http_request` with
`bearerSecretName: "GH_TOKEN"` and the GitHub URL. Example request shape:

```json
{
  "method": "GET",
  "url": "https://api.github.com/repos/{SOURCE_REPO}/issues?state={STATE}&per_page={LIMIT}",
  "bearerSecretName": "GH_TOKEN",
  "headers": {
    "Accept": "application/vnd.github+json"
  }
}
```

Add API query parameters only when present:

- `labels=$LABEL`
- `assignee=$ASSIGNEE` after resolving `@me` through `GET /user`
- `milestone=$MILESTONE_NUMBER`; if the user supplied a title, first list
  milestones and match the title to a number

`gh issue list` excludes pull requests. API issue endpoints include pull
requests, so exclude any item with a `pull_request` field.

Hard failure rule: if the current turn did not execute a successful `gh issue
list`, GitHub Issues API, or equivalent `http_request` call, do not display an
issue table and do not say no issues matched. Report that live issue fetch did
not complete.

If watch context includes `PROCESSED_ISSUES`, filter those issue numbers out.
If no issues match, report that directly and, in watch mode, continue to Phase 6
to check review feedback.

Extract for each issue: number, title, body, label names, assignees, URL.

## Phase 3 - Present And Confirm

Display a compact table:

| # | Title | Labels | Assignees |
| --- | --- | --- | --- |

If fork mode is active, also say that branches will be pushed to `PUSH_REPO`
and PRs will target `SOURCE_REPO`.

If `--dry-run` is set, stop after the table. Do not run preflight.

If `--yes` is set, process every listed issue and proceed to Phase 4.

Otherwise ask:

> Which issues should I process: `all`, a comma-separated list of issue numbers,
> or `cancel`?

Wait for the user response. Continue only with selected issue numbers.

Watch behavior: ask on the first interactive poll unless `--yes` is set. Do not
schedule watch follow-up from a parse-only turn. After the user confirms issues
or after a `--yes` run completes, schedule the next run in Watch Mode.
Subsequent scheduled runs use `--cron --yes`.

## Phase 4 - Issue Processing Preflight

Run this phase only after selected issue numbers are known. These checks are for
delegating fixes, not for issue listing.

1. Resolve the local checkout.

   Use the current directory if it is a git repo whose `origin` matches
   `SOURCE_REPO`. If the current directory is not a matching checkout, ask the
   user for the local checkout path before processing. Issue listing does not
   require a local checkout, but fixing issues does.

2. Check the working tree.

   ```bash
   git status --porcelain
   ```

   If output is non-empty, explain that delegated fixes should start from a
   committed state and ask whether to continue. Never stage or commit unrelated
   changes.

3. Record the base branch.

   ```bash
   git rev-parse --abbrev-ref HEAD
   ```

   Store as `BASE_BRANCH`.

4. Verify remotes.

   ```bash
   git ls-remote --exit-code origin HEAD
   ```

   In fork mode, verify a `fork` remote exists for `PUSH_REPO`; add it only if
   missing, and use the normal GitHub remote URL. Do not write tokens into git
   config.

5. Skip issues that already have open PRs from the intended branch owner.

   ```bash
   gh pr list --repo "$SOURCE_REPO" --state open \
     --head "fix/issue-$ISSUE_NUMBER" \
     --json number,url,headRefName,headRepositoryOwner \
     --jq ".[] | select(.headRepositoryOwner.login == \"$PUSH_OWNER\")"
   ```

   If `gh` is unavailable, use `http_request` with
   `bearerSecretName: "GH_TOKEN"`:

   ```json
   {
     "method": "GET",
     "url": "https://api.github.com/repos/{SOURCE_REPO}/pulls?head={PUSH_OWNER}:fix/issue-{ISSUE_NUMBER}&state=open&per_page=1",
     "bearerSecretName": "GH_TOKEN",
     "headers": {
       "Accept": "application/vnd.github+json"
     }
   }
   ```

6. Skip issues whose intended branch exists in `PUSH_REPO`.

   ```bash
   BRANCH_REF="fix%2Fissue-$ISSUE_NUMBER"
   gh api "repos/$PUSH_REPO/branches/$BRANCH_REF" --silent
   ```

   If `gh` is unavailable, use `http_request` with
   `bearerSecretName: "GH_TOKEN"` against:
   `https://api.github.com/repos/{PUSH_REPO}/branches/fix%2Fissue-N`.

7. Track claims for cron/watch dedupe when durable state storage is available.

   Use `$HYBRIDCLAW_STATE_DIR/gh-issues` when that variable is set, otherwise
   `$HOME/.hybridclaw/data/gh-issues`. Create the directory if needed. Store
   claims in `claims.json`, creating it as `{}` if missing. Remove claims older
   than 2 hours. For each remaining issue, skip if key
   `SOURCE_REPO#ISSUE_NUMBER` is claimed. Never write claim or cursor files into
   the target repository checkout.

If all selected issues are skipped, report why and, in watch mode, continue to
Phase 6.

## Phase 5 - Delegate Issue Fixes

Before each delegate call, write or refresh the claim for that issue when the
claims file is available. Include enough context for the delegated task to work
without reading this orchestration transcript.

Cron mode:

- Use `cursor-SOURCE_REPO_SLUG.json` in the same HybridClaw state directory as
  the claims file.
- Create it as `{"last_processed":null,"in_progress":null}` if missing.
- Select one eligible issue only: not claimed, no open PR, no branch, and after
  `last_processed` when possible. Wrap to the first eligible issue if needed.
- Mark `in_progress`, delegate one issue, report the spawn, and exit. Do not
  wait for results.

Normal mode:

- Use `delegate` in `parallel` mode for up to 6 independent issues at a time.
- If more than 6 issues are selected, process the next batch after the previous
  batch reports back.
- Do not sleep or busy-wait.

Delegate task shape:

```text
You are a focused issue-fix subagent. Fix exactly one GitHub issue and open a PR.

Repository: {SOURCE_REPO}
Push repository: {PUSH_REPO}
Fork mode: {FORK_MODE}
Push remote: {PUSH_REMOTE}
Base branch: {BASE_BRANCH}
Branch: fix/issue-{NUMBER}
Notification target: {NOTIFY_CHANNEL}

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
8. If a notification target is present, send only the final PR summary to that
   target with the message tool; do not send status chatter.
9. Return: PR URL, files changed, tests run, skipped checks, and caveats.

Constraints:
- Do not modify unrelated files.
- Do not force-push.
- Do not commit secrets, local config, or personal data.
- If the working tree contains unrelated changes, leave them untouched.
- If the issue is vague, too large, or not reproducible, return analysis and
  mark it for manual triage instead of opening a speculative PR.
```

Result collection:

- In cron mode, skip collection because the orchestrator exits after spawning.
- In normal mode, collect delegate results and present:

| Issue | Status | PR | Notes |
| --- | --- | --- | --- |

Statuses: `PR opened`, `Skipped`, `Failed`, `Timed out`, `Needs manual review`.

Store opened PRs as `OPEN_PRS` with PR number, branch, URL, and issue number for
Phase 6.

If `--notify-channel` is set, send a final summary only after the batch
finishes. Do not include issue bodies, review bodies, tokens, or transcripts.

## Phase 6 - PR Review Handler

This phase monitors open issue-fix PRs for actionable review feedback.

It runs:

- after Phase 5 results, for PRs just opened
- when `--reviews-only` is set
- during watch or cron review runs

Discover PRs:

- If `OPEN_PRS` exists from Phase 5, inspect those first.
- Otherwise list open PRs whose head branch starts with `fix/issue-`:

```bash
gh pr list --repo "$SOURCE_REPO" --state open \
  --json number,title,url,headRefName,body \
  --jq '.[] | select(.headRefName | startswith("fix/issue-"))'
```

Fetch review sources for each candidate:

```bash
gh pr view "$PR_NUMBER" --repo "$SOURCE_REPO" \
  --json number,title,url,body,reviews,comments,reviewDecision
gh api "repos/$SOURCE_REPO/pulls/$PR_NUMBER/comments"
gh api "repos/$SOURCE_REPO/issues/$PR_NUMBER/comments"
```

Also inspect the PR body for embedded review content such as
`<!-- greptile_comment -->` or structured sections from review bots.

Determine the bot username with:

```bash
gh api user --jq .login
```

Exclude comments authored by that user and comments already answered with
addressed-style replies.

Actionable feedback includes:

- `CHANGES_REQUESTED` reviews
- comments asking for concrete changes, tests, error handling, or edge cases
- comments saying a change will fail, break, or cause an error
- inline comments identifying code defects
- embedded review sections that flag critical issues, expected failures,
  low-confidence concerns, or specific changes needed

Not actionable:

- approvals, LGTM, thanks, or pure acknowledgements
- CI summaries without a requested change
- bot-generated summaries with no concrete request
- stale comments already addressed

Build `ACTIONABLE_COMMENTS` with source, author, body, path, line, diff hunk,
comment ID, and URL when available.

If no actionable comments are found, report that and stop unless watch mode
needs scheduling.

Display a table:

| PR | Branch | Actionable Comments | Sources |
| --- | --- | --- | --- |

Unless `--yes`, `--cron`, or a subsequent scheduled watch run is active, ask
which PRs to address: `all`, comma-separated PR numbers, or `skip`.

Cron review mode:

- Process at most one PR with actionable comments.
- Delegate one review-fix task and exit without waiting.

Normal review mode:

- Use `delegate` in `parallel` mode for up to 6 PRs at a time.

Review delegate task shape:

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
3. Implement only requested review fixes.
4. Run targeted tests or explain why none apply.
5. Commit with `fix: address review feedback on PR #{PR_NUMBER}`.
6. Push the branch.
7. Reply to addressed comments with a brief summary and commit SHA. For
   unresolved or contradictory comments, reply with the reason and mark manual
   follow-up.
8. Return: comments addressed, comments skipped, commit SHA, files changed,
   tests run, and manual follow-ups.

Constraints:
- Do not force-push.
- Do not rewrite unrelated PR history.
- Do not change files unrelated to the actionable comments.
- If comments conflict, address the newest concrete request and flag the
  conflict.
```

After review delegates finish, present:

| PR | Comments Addressed | Comments Skipped | Commit | Status |
| --- | --- | --- | --- | --- |

Track addressed comment IDs in `ADDRESSED_COMMENTS` for watch context.

## Watch Mode

HybridClaw must not sleep in the active turn. If `--watch` is set, use `cron`
to schedule a recurring follow-up prompt using the same repository and filters.

The initial `--watch` invocation is not a parse-only request. It must fetch the
current issue list first, present the table, and either ask for selected issue
numbers or honor `--yes`. Only schedule the recurring follow-up after that first
selection/processing path has run.

Use the `cron` tool for scheduled follow-up. Do not send a local `message` as a
substitute for scheduling. If `cron` is unavailable or scheduling fails, report
that watch scheduling failed.

The scheduled prompt must include:

- `SOURCE_REPO`, `PUSH_REPO`, `FORK_MODE`, `PUSH_REMOTE`
- filters: label, milestone, assignee, state, limit
- `--cron --yes`
- `--reviews-only` when the run should only monitor review feedback
- compact state: `PROCESSED_ISSUES`, `ADDRESSED_COMMENTS`, `OPEN_PRS`,
  cumulative one-line results, and `BASE_BRANCH` when known

The scheduled prompt must not include:

- issue bodies
- review bodies
- tokens
- subagent transcripts
- raw command output containing secrets

If a watch run finds no issue work, still run Phase 6. If no issue or review
work exists, report "No eligible issue or review work found" and let the next
scheduled run handle future polling.

## Safety Rules

- Keep branches scoped to one issue or one PR review batch.
- Prefer targeted validation over full-suite runs unless the touched area is
  broad.
- Never hide skipped checks; include them in summaries.
- Never weaken repository security policy, approval rules, branch protection, or
  CI configuration to make an issue easier to close.
- Do not print or store tokens. Do not put tokens into git remotes.
- If the issue is vague, too large, or not reproducible, report analysis and
  leave it for manual triage instead of opening a speculative PR.
