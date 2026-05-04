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
- production package metadata lives under `manifest:` or
  `metadata.hybridclaw.manifest:` and declares `id`, `version`,
  `capabilities`, `required_credentials`, and `supported_channels`

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
      - id: manim
        kind: uv
        package: manim
        bins: ["manim"]
        label: Install Manim (uv)
      - id: ffmpeg
        kind: brew
        formula: ffmpeg
        bins: ["ffmpeg"]
        label: Install ffmpeg (brew)
---
```

Operator surfaces:

- `hybridclaw skill list` and `/skill list` show declared dependency ids
- `hybridclaw skill install <skill> <dependency>` runs one declared dependency for the named skill
- `hybridclaw skill setup <skill>` runs every declared dependency for the named skill
- `/skill install <skill> <dependency>` does the same from local TUI or web chat
- `/skill setup <skill>` does the same for every declared dependency from local TUI or web chat

`skill install` and `skill setup` are limited to local TUI and web sessions
because they change the host dependency state.

## Catalog And Admin Surfaces

- `hybridclaw skill list` and `/skill list` group skills by category, show
  `available` / `disabled` / missing-dependency state, and mark
  higher-precedence foreign-source overrides with `*`
- skill list output includes any declared dependency ids and labels so operators
  can discover the right dependency before running `skill install` or
  `skill setup`
- the admin `Skills` page shows the same catalog metadata alongside
  adaptive-skill health and amendment review
- the admin `Skills` page can create a local skill from a form or upload a
  `.zip` containing a `SKILL.md`; both flows publish into the project
  `skills/` directory only after the scanner approves the contents

## Availability Controls

HybridClaw separates skill discovery from runtime availability.

- `skills.disabled` is the global disabled list
- `skills.channelDisabled.<channel>` blocks a skill in one channel. Current
  channel keys include `discord`, `msteams`, `signal`, `slack`, `telegram`,
  `voice`, `whatsapp`, `email`, and `imessage`.

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
- local directory path (e.g. `./my-skills/brand-voice`)
- local `.zip` archive (e.g. `./exports/brand-voice.zip`)

Examples:

- `hybridclaw skill import official/himalaya`
- `hybridclaw skill import skills-sh/anthropics/skills/brand-guidelines`
- `hybridclaw skill import clawhub/brand-voice`
- `hybridclaw skill import lobehub/github-issue-helper`
- `hybridclaw skill import claude-marketplace/brand-guidelines@anthropic-agent-skills`
- `hybridclaw skill import well-known:https://mintlify.com/docs`
- `hybridclaw skill import anthropics/skills/skills/brand-guidelines`
- `hybridclaw skill import ./my-local-skill`
- `hybridclaw skill import ./exports/brand-voice.zip`
- TUI or web slash surface: `/skill import official/himalaya`

Guard behavior:

- imported skills are treated as community trust, not bundled trust
- `--force` only overrides a `caution` scanner verdict
- `--skip-skill-scan` bypasses the scanner entirely for trusted operators
- `dangerous` verdicts stay blocked

### Troubleshooting: Skill exists but does not appear in `skill list`

If importing or uploading a skill reports that it already exists under
`~/.hybridclaw/skills/<skill-name>`, but `hybridclaw skill list` or
`/skill list` does not show it, the directory exists but the scanner did not
load it as a catalog entry.

Check the installed layout first. A community skill must have an uppercase
manifest file at `<skill-name>/SKILL.md`:

```bash
ls -la ~/.hybridclaw/skills/<skill-name>
find ~/.hybridclaw/skills/<skill-name> -maxdepth 2 -type f
```

Common fixes:

```bash
# Fix a lowercase manifest filename.
mv ~/.hybridclaw/skills/<skill-name>/skill.md \
  ~/.hybridclaw/skills/<skill-name>/SKILL.md

# Fix a zip that unpacked one directory too deep.
mv ~/.hybridclaw/skills/<skill-name>/<skill-name>/SKILL.md \
  ~/.hybridclaw/skills/<skill-name>/SKILL.md
```

The manifest frontmatter must include at least `name` and `description`:

```markdown
---
name: <skill-name>
description: Describe what this skill helps with.
---
```

Restart the gateway after fixing the files:

```bash
hybridclaw gateway stop
hybridclaw tui
```

If the skill still does not appear, inspect the gateway log for parse or guard
scanner messages:

```bash
rg "<skill-name>|Failed to parse skill|Blocked skill" \
  ~/.hybridclaw/data/gateway/gateway.log
```

When the installed directory is incomplete, move it aside and import the skill
again:

```bash
mv ~/.hybridclaw/skills/<skill-name> ~/.hybridclaw/skills/<skill-name>.bak
hybridclaw skill import ./<skill-name>.zip
```

## Package Lifecycle

Packaged business skills use audited lifecycle commands:

- `hybridclaw skill install <source>`
- `hybridclaw skill upgrade <source>`
- `hybridclaw skill uninstall <skill-name>`
- `hybridclaw skill revisions <skill-name>`
- `hybridclaw skill rollback <skill-name> <revision-id>`

Lifecycle commands update `skills.installed`, write audit events, and store
package snapshots in the existing runtime config revision database as `skill`
assets. `manifest.supported_channels` is enforced during skill loading so a
skill is not advertised in unsupported channel contexts.

See [How to Ship a Business Skill](../guides/skills/business-skills.md) for the
operator-facing packaging contract.

## Adaptive Skills

Observation, inspection, and guarded amendment workflows are configured under
`adaptiveSkills.*` and documented in [Adaptive Skills](./adaptive-skills.md).
