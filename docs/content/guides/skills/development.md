---
title: Development Skills
description: Code review, GitHub PR workflows, Salesforce inspection, and skill creation tools.
sidebar_position: 3
---

# Development Skills

## code-review

Review diffs and change sets for bugs, regressions, risks, and missing tests.

**Prerequisites** — `git`, optionally `gh` (GitHub CLI) for PR reviews.

> 💡 The skill reviews by severity: incorrect logic, auth/secret mistakes, missing validation, risky coupling, flaky tests.

> 💡 It searches for leftover `console.log`, `TODO`, `FIXME`, passwords, and tokens automatically.

> 💡 For GitHub PRs, it uses `gh pr view` and checks CI status.

> 🎯 **Try it yourself**

> 🎯 `Review the diff on my current branch for bugs and security issues`

> 🎯 `Review PR #42 and list findings by severity`

> 🎯 `Look at the changes in src/auth/ and flag anything risky`

> 🎯 `Review the diff on my current branch, run the test suite to check for regressions, and create a summary of all findings sorted by severity with file and line references`

**Troubleshooting**

- **`gh` not authenticated** — run `gh auth login` before PR reviews.
- **Large diffs** — the skill reads changed files individually; very large
  PRs may take longer.

---

## github-pr-workflow

Create branches, commit and push changes, open or update GitHub pull requests,
handle CI, and merge safely.

**Prerequisites** — `git`, `gh` (GitHub CLI, authenticated).

> 💡 The skill follows a fixed sequence: sync base, branch, implement, commit, push, open PR, watch CI, address feedback, merge.

> 💡 Prefer small, focused PRs. If stacking PRs, make the dependency explicit.

> 💡 Use `gh pr checks --watch` to wait for CI to finish.

> 🎯 **Try it yourself**

> 🎯 `Create a branch called "fix/null-check-user", add a null guard in src/auth/session.ts, and open a PR against main`

> 🎯 `Push my current changes and open a draft PR with a summary`

> 🎯 `Check CI status on my open PR and fix any failures`

> 🎯 `Address the review comments on PR #55 and push an update`

> 🎯 `Create a branch called "feat/user-avatars", implement an avatar upload component in src/components/Avatar.tsx, run tests, commit with a descriptive message, push, and open a PR against main with a full summary`

**Troubleshooting**

- **Push rejected** — likely need to `git pull --rebase` first.
- **CI fails** — the skill will attempt to read failure logs and fix locally
  before re-pushing.

---

## salesforce

Inspect Salesforce objects, fields, relationships, Tooling API metadata, and
SOQL rows with a bundled Python helper. Read-only by default.

**Prerequisites**

| Dependency | Purpose | Install |
|---|---|---|
| `python3` | Required runtime | System install |
| Salesforce credentials | Stored secrets: `SF_FULL_USERNAME`, `SF_FULL_PASSWORD`, `SF_FULL_CLIENTID`, `SF_FULL_SECRET`, `SF_DOMAIN` | Configure via HybridClaw secrets |

> 💡 Always run `objects` or `describe` before writing SOQL against unfamiliar objects.

> 💡 Use `relations` to discover join paths between objects.

> 💡 Add `LIMIT` to queries on large tables to avoid timeouts.

> 💡 The helper uses `<secret:NAME>` placeholders resolved server-side — secrets never touch disk.

> 🎯 **Try it yourself**

> 🎯 `List all Salesforce objects that contain "Account" in the name`

> 🎯 `Describe the fields on the Opportunity object`

> 🎯 `Query the 10 most recent Contacts with their Account names`

> 🎯 `Show me the relationships between Case and Account`

> 🎯 `Describe the Contact object, find all required fields, then query the 5 most recently created Contacts and show which required fields are empty`

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

> 💡 Follow the three-layer model: frontmatter (triggers + metadata), SKILL.md body (core workflow), references/scripts/assets (detail).

> 💡 Keep SKILL.md concise — the model already knows general concepts; only include what is unique to your skill.

> 💡 Use `quick_validate.py` to check your skill before publishing.

> 🎯 **Try it yourself**

> 🎯 `Create a new skill called "brand-voice" that enforces our writing style guide with rules: active voice, no jargon, sentences under 25 words`

> 🎯 `Validate the frontmatter and structure of my custom skill in ./my-skills/seo-audit`

> 🎯 `Scaffold a new skill called "changelog-writer", add a brew dependency for git, write the SKILL.md with trigger rules for changelog generation requests, and validate the result`

---

## code-simplification

*(Model-invoked, not user-invocable)*

Refactors code to reduce complexity and duplication without changing behavior.
Activated automatically during code-review and refactoring workflows. Moves
include: nested ifs to early returns, extract helpers, inline dead wrappers,
split data gathering from side effects.
