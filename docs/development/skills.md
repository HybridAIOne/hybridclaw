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

## Invocation Paths

- `/skill <name> [input]`
- `/skill:<name> [input]`
- `/<name> [input]` if `user-invocable: true`

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
- admin `Skills` page for the current disabled list plus adaptive-skill review

`--channel teams` is normalized to `msteams`.

## Adaptive Skills

Observation, inspection, and guarded amendment workflows are configured under
`adaptiveSkills.*` and documented in [Adaptive Skills](./adaptive-skills.md).
