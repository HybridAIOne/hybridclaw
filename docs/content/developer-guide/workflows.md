---
title: Workflow Engine
description: Declarative YAML workflows with A2A dispatch, F8 stakes escalation, and revision rewinds.
---

# Workflow Engine

HybridClaw workflows are declarative YAML files that dispatch ordered work to
coworkers through A2A envelopes. Steps run autonomously by default. A step only
pauses when it declares `stakes_threshold` and the configured F8 stakes
classifier scores the step above that bound.

```yaml
id: brief_build_review
name: Brief build review
steps:
  - id: brief
    owner_coworker_id: briefing
    action: Write a concise marketing copy brief from the source context.
    stakes_threshold: medium
  - id: build
    owner_coworker_id: builder
    action: Build the first marketing copy draft from the approved brief.
    stakes_threshold: medium
  - id: review
    owner_coworker_id: reviewer
    action: Review the client-facing marketing copy before publication.
    stakes_threshold: medium
transitions:
  - from: brief
    to: build
  - from: build
    to: review
```

Required fields are `id`, `name`, `steps[].owner_coworker_id`,
`steps[].action`, and `transitions`. Transitions define one linear path through
the steps; branching and fan-in are rejected. `steps[].stakes_threshold` is
optional and accepts `low`, `medium`, or `high`.

Starter templates live in `presets/workflows/`:

- `brief-build-review.yaml`
- `intake-triage-assign.yaml`
- `draft-legal-publish.yaml`

Runtime state is persisted as workflow revision assets, preserving step
artifacts across `returnForRevision(runId, stepId, notes)` rewinds. Operators
can run and resume workflows from the gateway with:

```text
workflow list
workflow start <workflow_id> [run_id]
workflow approve <run_id> [step_id]
workflow return <run_id> <step_id> <notes>
```

The admin console also exposes a Workflows page backed by
`GET /api/admin/workflows`, with per-run approve and return actions. The
visualizer shows the active step, owner, status, stakes score, and pending
escalation state.

Workflow approval prompts expire after 24 hours by default. Operators can tune
that window with `HYBRIDCLAW_WORKFLOW_APPROVAL_TTL_MS`, expressed in
milliseconds.
