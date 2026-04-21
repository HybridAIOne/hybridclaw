---
title: Development Skills
description: Code review, GitHub issue automation, PR workflows, Salesforce inspection, and skill creation tools.
sidebar_position: 3
---

# Development Skills

## code-review

Review diffs and change sets for bugs, regressions, risks, and missing tests.

**Prerequisites** — `git`, optionally `gh` (GitHub CLI) for PR reviews.

> 💡 **Tips & Tricks**
>
> The skill reviews by severity: incorrect logic, auth/secret mistakes, missing validation, risky coupling, flaky tests.
>
> It searches for leftover `console.log`, `TODO`, `FIXME`, passwords, and tokens automatically.
>
> For GitHub PRs, it uses `gh pr view` and checks CI status.

> 🎯 **Try it yourself**
>
> `Review the diff on my current branch for bugs and security issues`
>
> `Review PR #42 and list findings by severity`
>
> `Look at the changes in src/auth/ and flag anything risky`
>
> `Review the diff on my current branch, run the test suite to check for regressions, and create a summary of all findings sorted by severity with file and line references`
>
> **Conversation flow:**
>
> `1. Review the diff on my current branch and list all findings by severity`
> `2. The auth token validation issue you flagged — show me the exact code path and suggest a fix`
> `3. Apply the fix, re-run the tests, and confirm the issue is resolved`

**Troubleshooting**

- **`gh` not authenticated** — run `gh auth login` before PR reviews.
- **Large diffs** — the skill reads changed files individually; very large
  PRs may take longer.

---

## github-pr-workflow

Create branches, commit and push changes, open or update GitHub pull requests,
handle CI, and merge safely.

**Prerequisites** — `git`, `gh` (GitHub CLI, authenticated).

> 💡 **Tips & Tricks**
>
> The skill follows a fixed sequence: sync base, branch, implement, commit, push, open PR, watch CI, address feedback, merge.
>
> Prefer small, focused PRs. If stacking PRs, make the dependency explicit.
>
> Use `gh pr checks --watch` to wait for CI to finish.

> 🎯 **Try it yourself**
>
> `Create a branch called "fix/null-check-user", find any functions that access user properties without null checks, add guards, and open a PR against main`
>
> `Push my current changes and open a draft PR with a summary`
>
> `Check CI status on my open PR and fix any failures`
>
> `Address the review comments on PR #55 and push an update`
>
> `Create a branch called "feat/add-healthcheck", add a /healthz endpoint that returns status and uptime, write a test for it, commit with a descriptive message, push, and open a PR against main with a full summary`
>
> **Conversation flow:**
>
> `1. Create a branch called "feat/rate-limiter" and add a middleware that limits requests to 100/min per IP`
> `2. Write unit tests for the rate limiter covering normal traffic, burst traffic, and IP reset after the window expires`
> `3. Push everything, open a PR against main, and watch CI until it passes`

**Troubleshooting**

- **Push rejected** — likely need to `git pull --rebase` first.
- **CI fails** — the skill will attempt to read failure logs and fix locally
  before re-pushing.

---

## gh-issues

Process GitHub issues as an automation queue: list and filter issues, confirm
selected issue numbers, deduplicate `fix/issue-*` work, delegate one focused PR
per issue, and monitor review feedback on issue-fix PRs.

**Prerequisites** — `git`, `gh` (GitHub CLI, authenticated).

> 💡 **Tips & Tricks**
>
> Use `--dry-run` first to inspect the issue set without creating branches or
> delegations.
>
> Add `--label`, `--milestone`, `--assignee`, and `--limit` filters to keep
> each batch focused.
>
> Use `--reviews-only` to address actionable comments on open `fix/issue-*`
> PRs.
>
> Use `--fork owner/repo` when branches should be pushed to a fork while PRs
> target the source repo.
>
> Use `--watch --interval 15` for recurring queue follow-up. HybridClaw
> schedules the next run instead of sleeping in the current turn.
>
> Use `--cron --yes` for scheduled runs that process at most one eligible item
> and exit.
>
> Use `--notify-channel <target>` to send the final PR summary to a HybridClaw
> message target without sending intermediate status chatter.

> 🎯 **Try it yourself**
>
> `/gh-issues <your repo> --label bug --limit 3 --dry-run`
>
> `/gh-issues <your repo> --label bug --limit 2`
>
> `/gh-issues <your repo> --reviews-only`
>
> `/gh-issues <your repo> --fork <your fork> --label help-wanted --limit 1`
>
> `/gh-issues <your repo> --watch --interval 15 --label bug --limit 5`
>
> `/gh-issues <your repo> --cron --yes --reviews-only`
>
> **Conversation flow:**
>
> `1. /gh-issues <your repo> --label bug --limit 5 --dry-run`
> `2. Process issues 42 and 48 only`
> `3. After the PRs are open, run /gh-issues <your repo> --reviews-only`

**Troubleshooting**

- **`gh` not authenticated** — run `gh auth login` or provide `GH_TOKEN`.
- **Existing branch or PR** — the skill skips issues that already have a
  `fix/issue-*` branch or open PR.
- **Local checkout missing** — issue listing can run with only `owner/repo`,
  but processing selected issues needs a matching local git checkout.
- **Unclear issue** — delegated agents stop and report low confidence instead
  of opening speculative PRs.
- **Wrong workflow** — use `github-pr-workflow` for current-branch PR work, CI
  fixes, or a known PR; use `gh-issues` when the entry point is an issue queue.

---

## salesforce

Inspect Salesforce objects, fields, relationships, Tooling API metadata, and
SOQL rows with a bundled Python helper. Read-only by default.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `python3` | Required runtime | System install |
| Salesforce credentials | Stored secrets: `SF_FULL_USERNAME`, `SF_FULL_PASSWORD`, `SF_FULL_CLIENTID`, `SF_FULL_SECRET`, `SF_DOMAIN` | Configure via HybridClaw secrets |

> 💡 **Tips & Tricks**
>
> Always run `objects` or `describe` before writing SOQL against unfamiliar objects.
>
> Use `relations` to discover join paths between objects.
>
> Add `LIMIT` to queries on large tables to avoid timeouts.
>
> The helper uses `<secret:NAME>` placeholders resolved server-side — secrets never touch disk.

> 🎯 **Try it yourself**
>
> `List all Salesforce objects that contain "Account" in the name`
>
> `Describe the fields on the Opportunity object`
>
> `Query the 10 most recent Contacts with their Account names`
>
> `Show me the relationships between Case and Account`
>
> `Describe the Contact object, find all required fields, then query the 5 most recently created Contacts and show which required fields are empty`
>
> **Conversation flow:**
>
> `1. List all custom objects in our Salesforce org that were created in the last 6 months`
> `2. Describe the fields on the newest custom object and show its relationships to Account and Contact`
> `3. Query the 10 most recent records from that object and flag any with missing required fields`

**Troubleshooting**

- **Authentication errors** — verify all five stored secrets are set and
  `SF_DOMAIN` is `login` (production) or `test` (sandbox).
- **SOQL query fails** — check field API names with `describe` first; display
  labels differ from API names.

---

## skill-creator

Create and update `SKILL.md`-based skills with strong trigger metadata, lean
docs, and reliable init/validate/package/publish workflows.

**Prerequisites** — none.

> 💡 **Tips & Tricks**
>
> Follow the three-layer model: frontmatter (triggers + metadata), SKILL.md body (core workflow), references/scripts/assets (detail).
>
> Keep SKILL.md concise — the model already knows general concepts; only include what is unique to your skill.
>
> Use `quick_validate.py` to check your skill before publishing.

> 🎯 **Try it yourself**
>
> `Create a new skill called "brand-voice" that enforces our writing style guide with rules: active voice, no jargon, sentences under 25 words`
>
> `Scaffold a new skill called "seo-audit" that triggers on SEO review requests, then validate its frontmatter and structure`
>
> `Scaffold a new skill called "changelog-writer", add a brew dependency for git, write the SKILL.md with trigger rules for changelog generation requests, and validate the result`
>
> **Conversation flow:**
>
> `1. Create a new skill called "deploy-checklist" that triggers on deploy or release requests`
> `2. Add a pre-deploy validation script that checks for uncommitted changes, passing tests, and a valid changelog entry`
> `3. Validate the skill structure and run a dry-run to make sure the trigger rules match correctly`

---

## code-simplification

*(Model-invoked, not user-invocable)*

Refactors code to reduce complexity and duplication without changing behavior.
Activated automatically during code-review and refactoring workflows. Moves
include: nested ifs to early returns, extract helpers, inline dead wrappers,
split data gathering from side effects.
