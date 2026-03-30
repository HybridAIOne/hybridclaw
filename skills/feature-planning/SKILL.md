---
name: feature-planning
description: Break features into implementation plans, acceptance criteria, and sequenced tasks.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - planning
      - engineering
      - implementation
      - delivery
    related_skills:
      - project-manager
      - github-pr-workflow
---

# Feature Planning

Use this skill to turn a feature request into an implementation plan that is
specific enough to execute without rediscovering the codebase.

## Planning Workflow

1. Confirm the goal, constraints, and non-goals.
2. Inspect the current code paths, types, tests, and similar features.
3. Identify the files and system boundaries likely to change.
4. Break the work into small sequenced tasks.
5. Define validation for each stage and for the final change.
6. Capture risks, dependencies, and unanswered questions.

## Default Output

When the user asks for a plan and does not specify a format, use:

1. Goal
2. Current state
3. Proposed approach
4. Task breakdown
5. Validation plan
6. Risks and unknowns
7. Recommended next action

## Task Rules

Each task should have one concrete outcome. Prefer:

- exact file paths instead of vague module names
- explicit commands instead of "run the tests"
- acceptance criteria that can be verified
- clear notes on migrations, docs, config, or rollout work when relevant

If the scope is large, group tasks into milestones, but keep each task small
enough that an implementer can finish it without further decomposition.

## Codebase Exploration

Before finalizing a plan, inspect the repo for:

- existing patterns that should be preserved
- nearby tests and fixtures
- configuration or schema touchpoints
- user-facing docs or CLI/help text that may need updates

Use the existing codebase to anchor the plan instead of inventing new patterns.

## Validation Expectations

Every plan should name the checks needed to prove the change works. Prefer the
smallest useful set, for example:

```bash
npm run typecheck
npm run lint
npm run test:unit
```

Replace generic commands with repo-specific ones after inspecting the project.

## Working Rules

- Separate required work from optional polish.
- State assumptions when dates, estimates, or dependencies are uncertain.
- Sequence risky or high-uncertainty work before cleanup and polish.
- Name what will not change so scope stays bounded.
- Flag decisions that need user input instead of hiding them in the plan.

## Common Outputs

Use whichever artifact best fits the request:

- implementation plan
- milestone breakdown
- acceptance criteria
- rollout checklist
- dependency map
- risk register

For plans that will be handed to another implementer, optimize for clarity over
brevity: exact files, concrete commands, and explicit success criteria.
