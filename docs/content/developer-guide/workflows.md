---
title: Workflows
description: Declarative YAML workflow definition schema and validation rules.
sidebar_position: 6
---

# Workflows

Workflow definitions are YAML documents that describe named, agent-owned
steps and explicit transitions between them. The schema is intentionally small:
runtime escalation is expressed with `stakes_threshold`, not with a
`requires_approval` flag.

## Schema

Required top-level fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable workflow identifier |
| `name` | string | Human-readable workflow name |
| `steps` | array | One or more agent-owned actions |
| `transitions` | array | One or more directed edges between step IDs |

Step fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable step identifier used by transitions |
| `owner_coworker_id` | string | Agent responsible for the step (field rename to `owner_agent_id` tracked in [#710](https://github.com/HybridAIOne/hybridclaw/issues/710)) |
| `action` | string | Work to perform at that step |
| `stakes_threshold` | `low`, `medium`, or `high` | Optional escalation threshold |

Transitions use `from` and `to` step IDs. Validation rejects duplicate step IDs,
unknown transition targets, unknown fields, and `requires_approval`.

## Example

```yaml
id: workflow_launch_package
name: Launch package workflow
steps:
  - id: brief
    owner_coworker_id: agent_briefing
    action: Prepare the launch brief from approved source notes.
    stakes_threshold: medium
  - id: build
    owner_coworker_id: agent_builder
    action: Draft the launch package artifacts.
    stakes_threshold: medium
  - id: review
    owner_coworker_id: agent_reviewer
    action: Review the package before any client-visible update.
    stakes_threshold: high
transitions:
  - from: brief
    to: build
  - from: build
    to: review
```

When `stakes_threshold` is present, the workflow definition records the desired
stakes floor for that step. The runtime classifier decides whether the actual
operation escalates.
