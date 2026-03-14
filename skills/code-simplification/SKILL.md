---
name: code-simplification
description: Use this skill for behavior-preserving code refactors that reduce complexity, remove duplication, simplify nested logic, or make an implementation materially easier to maintain.
user-invocable: false
metadata:
  hybridclaw:
    tags:
      - engineering
      - refactoring
      - simplicity
      - maintainability
    related_skills:
      - code-review
      - feature-planning
---

# Code Simplification

Use this skill for deeper code simplification work while preserving current
behavior.

This is intentionally narrower than a generic "simplify" skill: it is for
behavior-preserving refactors in a live codebase, with explicit attention to
tests, surrounding types, and incremental validation.

## Default Workflow

1. Identify the exact behavior that must stay the same.
2. Read the surrounding code, types, and tests before editing.
3. Establish a baseline with the smallest relevant checks.
4. Simplify in small reversible steps.
5. Re-run validation after each meaningful change.
6. Stop when the code is materially clearer, not when it is merely different.

## What to Simplify

Prioritize complexity that makes defects more likely:

- deep nesting that can become guard clauses
- duplicated logic that can become one local helper
- conditionals split across too many locations
- wrappers or abstractions with no real caller benefit
- long functions that can be split by responsibility
- state transitions that are hard to follow or partially duplicated

Prefer deleting code over adding a new abstraction when both solve the problem.

## Working Rules

- Preserve behavior first; simplification is not a license for feature changes.
- Keep refactors small enough that failures are easy to localize.
- Use existing project patterns instead of inventing a new style.
- Avoid introducing generic helpers until there are at least a few stable call
  sites that justify them.
- If the code is complex because of a real domain constraint, document that
  before trying to flatten it away.

## Common Moves

Use whichever move makes the code simpler without broad churn:

- convert nested `if` chains into early returns
- extract one focused helper from repeated branches
- replace boolean flag tangles with clearer named conditions
- inline one-off wrappers that only obscure data flow
- split data gathering from side effects
- rename unclear variables when the current names hide intent

## Validation

Before changing anything, identify the most relevant checks. Typical examples:

```bash
git diff --stat
npm run typecheck
npm run test:unit
```

Replace generic commands with repo-native validation after inspecting the
project. If tests are missing for the behavior you are simplifying, add or note
that gap before making broad structural changes.

## Output Expectations

When reporting simplification work, explain:

1. what complexity was removed
2. what behavior was intentionally preserved
3. what validation was run
4. any remaining complexity that should stay for now

If the requested simplification is too risky without first adding tests, say so
directly and recommend the smallest safe precursor change.

## Pitfalls

- Do not mix simplification with unrelated feature work.
- Do not create a framework-sized abstraction to remove a few repeated lines.
- Do not collapse meaningful names into shorter but less clear code.
- Do not rewrite a large module in one pass when incremental cleanup is
  possible.
