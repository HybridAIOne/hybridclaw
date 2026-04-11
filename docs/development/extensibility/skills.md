---
title: Skills Internals
description: Skill roots, precedence, invocation rules, and runtime behavior for HybridClaw skills.
sidebar_position: 3
---

# Skills Internals

HybridClaw supports `SKILL.md`-based skills in `<skill-name>/SKILL.md`.

## Skill Roots

Skill roots include:

- `config.skills.extraDirs[]`
- bundled package skills in `skills/`
- `$CODEX_HOME/skills`
- `~/.codex/skills`
- `~/.claude/skills`
- `~/.agents/skills`
- project or workspace roots: `./.agents/skills`, `./skills`

## Resolution Rules

- precedence: `extra < bundled < codex < claude < agents-personal < agents-project < workspace`
- skills merge by `name`
- higher-precedence definitions override lower-precedence ones
- trust-aware scanning blocks risky personal or workspace skills
- bundled repo skills are mirrored into `/workspace/skills/<name>` inside the agent runtime so bundled script paths like `skills/pdf/scripts/...` stay valid

## Frontmatter Contract

- required: `name`, `description`
- optional: `user-invocable`, `disable-model-invocation`, `always`,
  `requires.*`, `metadata.hybridclaw.*`
- `metadata.hybridclaw.category` groups `skill list`, TUI, and admin catalog
  views under one normalized label
- `metadata.hybridclaw.short_description`, `tags`, `related_skills`, and
  `install` feed operator-facing summaries, related-skill hints, and install
  helpers
- installer metadata lives under `metadata.hybridclaw.install:`

## Invocation Paths

- `/skill <name> [input]`
- `/skill:<name> [input]`
- `/<name> [input]` if `user-invocable: true`
- After an explicit skill invocation, the next plain-text turn in the same
  session continues that skill automatically unless the user starts a new slash
  command.

## Dependency Installers

Skills can declare operator-run installers for required local dependencies.

Supported install kinds:

- `brew`
- `uv`
- `npm`
- `node`
- `go`
- `download`

Example:

```yaml
---
name: manim-video
description: Render Manim explainers.
metadata:
  hybridclaw:
    install:
      - id: uv-manim
        kind: uv
        package: manim
        bins:
          - manim
        label: Install Manim (uv)
      - id: brew-ffmpeg
        kind: brew
        formula: ffmpeg
        bins:
          - ffmpeg
        label: Install ffmpeg (brew)
---
```

Operator surfaces:

- `hybridclaw skill list` and `/skill list` show declared dependency ids
- `hybridclaw skill install <skill> <dependency>` runs one declared dependency for the named skill
- `/skill install <skill> <dependency>` does the same from local TUI or web chat

`skill install` is limited to local TUI and web sessions because it changes the
host dependency state.

## Catalog And Admin Surfaces

- `hybridclaw skill list` and `/skill list` group skills by category, show
  `available` / `disabled` / missing-dependency state, and mark
  higher-precedence foreign-source overrides with `*`
- skill list output includes any declared dependency ids and labels so operators
  can discover the right dependency before running `skill install`
- the admin `Skills` page shows the same catalog metadata alongside
  adaptive-skill health and amendment review
- the admin `Skills` page can create a local skill from a form or upload a
  `.zip` containing a `SKILL.md`; both flows publish into the project
  `skills/` directory only after the scanner approves the contents

## Availability Controls

HybridClaw separates skill discovery from runtime availability.

- `skills.disabled` is the global disabled list
- `skills.channelDisabled.discord`
- `skills.channelDisabled.msteams`
- `skills.channelDisabled.whatsapp`
- `skills.channelDisabled.email`

Operator surfaces:

- `hybridclaw skill enable <name> [--channel <kind>]`
- `hybridclaw skill disable <name> [--channel <kind>]`
- `hybridclaw skill toggle [--channel <kind>]` for the interactive checklist
- TUI `/skill config` for the same checklist over the gateway
- admin `Skills` page for the current disabled list, local skill authoring,
  ZIP upload, and adaptive-skill review

`--channel teams` is normalized to `msteams`.

## Community Skill Imports

Community skills install into `~/.hybridclaw/skills`. Supported import sources
are:

- `official/<skill-name>` for packaged community skills shipped with HybridClaw
- `skills-sh/<owner>/<repo>/<skill>`
- `clawhub/<skill-slug>`
- `lobehub/<agent-id>`
- `claude-marketplace/<skill>[@<marketplace>]`
- `claude-marketplace/<plugin>/<skill>[@<marketplace>]`
- `well-known:https://example.com/docs`
- `<owner>/<repo>/<path>`
- `https://github.com/<owner>/<repo>[/path]`

Examples:

- `hybridclaw skill import official/himalaya`
- `hybridclaw skill import skills-sh/anthropics/skills/brand-guidelines`
- `hybridclaw skill import clawhub/brand-voice`
- `hybridclaw skill import lobehub/github-issue-helper`
- `hybridclaw skill import claude-marketplace/brand-guidelines@anthropic-agent-skills`
- `hybridclaw skill import well-known:https://mintlify.com/docs`
- `hybridclaw skill import anthropics/skills/skills/brand-guidelines`
- TUI or web slash surface: `/skill import official/himalaya`

Guard behavior:

- imported skills are treated as community trust, not bundled trust
- `--force` only overrides a `caution` scanner verdict
- `--skip-skill-scan` bypasses the scanner entirely for trusted operators
- `dangerous` verdicts stay blocked

## Adaptive Skills

Observation, inspection, and guarded amendment workflows are configured under
`adaptiveSkills.*` and documented in [Adaptive Skills](./adaptive-skills.md).
