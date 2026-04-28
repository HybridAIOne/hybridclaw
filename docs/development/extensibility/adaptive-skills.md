---
title: Adaptive Skills
description: The self-improving skill loop, operator workflow, amendment flow, and retention behavior.
sidebar_position: 5
---

# Adaptive Skills

"AdaptiveSkills" is the self-improving skill loop in HybridClaw. It keeps
observation data in SQLite, inspects that data for degraded skills, stages
guarded `SKILL.md` amendments, and can evaluate applied changes for rollback.

## Loop

AdaptiveSkills runs four steps:

1. `observe` records skill executions and feedback in `skill_observations`
2. `inspect` computes health metrics from a trailing observation window
3. `learn` stages a guarded `SKILL.md` proposal when a skill degrades
4. `evaluate` decides whether an applied amendment improved outcomes enough to
   keep

The runtime keeps amendments in `skill_amendments` and emits structured audit
events for execution, inspection, proposal, apply, reject, and rollback steps.

## Enabling

Adaptive Skills is configured under `adaptiveSkills` in the runtime config and
is disabled by default.

```json
{
  "adaptiveSkills": {
    "enabled": true,
    "observationEnabled": true,
    "inspectionIntervalMs": 3600000,
    "observationRetentionDays": 30,
    "trailingWindowHours": 168,
    "minExecutionsForInspection": 5,
    "degradationSuccessRateThreshold": 0.6,
    "degradationToolBreakageThreshold": 0.3,
    "autoApplyEnabled": false,
    "evaluationRunsBeforeRollback": 10,
    "rollbackImprovementThreshold": 0.05,
    "trajectoryCapture": {
      "enabledAgentIds": [],
      "storeDir": ""
    }
  }
}
```

Key settings:

- `enabled`: turns on inspection, amendment staging, and evaluation
- `observationEnabled`: records executions and feedback even when the full loop
  is off
- `inspectionIntervalMs`: heartbeat cadence for inspection and retention work
- `observationRetentionDays`: keeps observation storage bounded; `0` disables
  pruning
- `trailingWindowHours`: observation lookback used when computing health
- `autoApplyEnabled`: only applies staged amendments automatically when the
  guard verdict is `safe` with zero findings
- `trajectoryCapture.enabledAgentIds`: opt-in agent IDs whose full redacted
  skill-run trajectories are appended to JSONL files
- `trajectoryCapture.storeDir`: optional trajectory store location; empty uses
  a `trajectories/` directory beside the runtime database, absolute paths are
  used as-is, and relative paths resolve under the runtime home directory

Legacy `skillCognee` config input is still normalized into `adaptiveSkills` for
backward compatibility.

## Observation Attribution

HybridClaw does not require explicit `/skill` invocation for observation.
Adaptive Skills records a skill when the run clearly activates exactly one skill,
for example by reading `skills/<name>/SKILL.md` or executing files under
`skills/<name>/`.

Explicit commands such as `/skill apple-music ...` still work as a direct
override, but plain-language skill use is also attributed when the evidence is
unambiguous.

Feedback signals currently come from:

- Discord `👎` reactions as negative feedback
- Discord `👍` and `❤️` reactions as positive feedback

Feedback is attached to the most recent observation for the same session.

## Retention

Observation queries are windowed, but storage is also pruned now. On each
inspection interval the heartbeat deletes `skill_observations` rows older than
`observationRetentionDays`.

This keeps high-traffic skills from accumulating unbounded observation history
while preserving the amendment history table as the durable review log.

## Operator Surfaces

Adaptive Skills can be managed from:

- CLI: `hybridclaw skill inspect`, `hybridclaw skill runs`, `hybridclaw skill learn`, `hybridclaw skill history`
- Gateway/TUI slash commands: `skill inspect`, `skill runs`, `skill learn`, `skill history`
- TUI: `/skill config` manages global and per-channel skill availability, separate from observation/amendment review
- Admin console: the `Skills` page now shows observed health, staged
  amendments, and amendment history
- Admin API:
  - `GET /api/skills/health`
  - `GET /api/skills/health/:name`
  - `GET /api/skills/amendments`
  - `GET /api/skills/amendments/:name`
  - `POST /api/skills/amendments/:name/apply`
  - `POST /api/skills/amendments/:name/reject`

## Command Flow

`skill inspect <name>` and `skill inspect --all` report observation-derived
health metrics, including success rate, tool breakage, positive feedback,
negative feedback, and degradation reasons.

`skill learn <name>` stages a guarded proposal using recent failures plus the
current `SKILL.md`. `--apply`, `--reject`, and `--rollback` then manage the
latest staged or applied amendment for that skill.

`skill runs <name>` shows recent execution observations for a skill.

`skill history <name>` shows amendment history, not per-run execution history.
