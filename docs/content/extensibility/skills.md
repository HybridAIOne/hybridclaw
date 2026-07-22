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

## API Helper Scripts

API-backed skills should expose deterministic `*.cjs` helper scripts as the
model-facing API wrapper. Keep the external-service details in the script:
endpoint selection, HTTP methods, payload shape, URL encoding, write-tier
classification, and secret references such as `bearerSecretName` or
`secretHeaders`.

Prefer small CLI subcommands that match model workflows. For live calls, the
normal helper command should send the helper-built request through the
HybridClaw gateway so the script remains the single owner of endpoint
selection, payload construction, approval metadata, and secret refs.

Provide a dry-run request mode, usually `--request`, that emits gateway-ready
JSON so the model can inspect the request or pass the returned request object
unchanged to `http_request` when direct gateway execution is unavailable. Avoid
requiring the model to reconstruct URLs, headers, request bodies, or secret
names from prose.

## Skill Authoring Best Practices

Treat a skill as a small contract between the operator, the model, and any
helper code shipped with the skill.

### Terms

| Term | Meaning |
|---|---|
| `SKILL.md` | The prompt contract: when to use the skill, what inputs are needed, how to route decisions, and what safety rules apply. |
| Helper script | A deterministic script, usually `*.cjs`, that owns API calls, request construction, execution, and output normalization. |
| Tool | A model-callable HybridClaw capability such as `bash`, `http_request`, file reads, browser automation, or MCP/plugin tools. |
| Gateway HTTP proxy | The `/api/http/request` path behind `http_request`; it enforces network policy, secret injection, response limits, and audit behavior. |
| Dry-run request | Helper output that describes the request without executing it, usually enabled with `--request`. |
| Live execution | Helper path that sends the helper-built request through the gateway and returns the live result. |
| Approval plan | Helper output for a guarded action that names the exact command to run after explicit operator confirmation. |
| Stakes tier | Skill-local risk classification: green for reads, amber for reversible or bounded writes requiring confirmation, red for forbidden operations. |
| SecretRef | A reference to a stored runtime secret; helpers should emit secret references, never raw secrets. |
| Config variable | A plaintext env-store value stored with `/env set` or `hybridclaw env set`; use for non-secret hostnames, IPs, account ids, or usernames that agents and helpers may reference. |

### What Goes In `SKILL.md`

Use `SKILL.md` for stable, abstract operating rules:

- the domain and when the skill should activate
- the helper command surface the model should use directly
- required inputs and where an operator can find them
- route selection rules such as local vs cloud, read vs write, or account vs
  resource-level APIs
- approval boundaries and forbidden operations
- result handling rules, including how to classify common failure layers
- credential names and how they are stored
- official API references and operational limits

Keep `SKILL.md` generic. Do not add prompt-specific steering, transcripts,
one-off troubleshooting patches, or prose that tells the model to match a
particular user wording. If behavior depends on request shape, encode that
shape in the helper command surface and tests.

### What Goes In The Helper

Put executable API knowledge in the helper:

- endpoint paths, HTTP methods, query parameters, JSON bodies, and pagination
- API version differences and local/cloud routing
- URL encoding and method-scoped paths
- validation of required flags and mutually exclusive options
- response normalization and useful error messages
- gateway execution, dry-run output, and approval-plan output
- rate-limit metadata, stakes tier, and cost measurement metadata
- secret references such as `bearerSecretName`, `secretHeaders`, strict
  `<secret:NAME>` placeholders, and captured response fields

The helper should use explicit flags and subcommands. Do not parse arbitrary
user prose with regexes. The model should choose from the documented helper
surface, not invent request bodies or infer API fields from a paragraph.

### Recommended Helper Shape

For API-backed skills, prefer a single helper entrypoint with noun/verb
commands and stable machine-readable output:

```text
node skills/<skill>/<helper>.cjs [--format json|pretty] [--request] <resource> <action> [flags]
node skills/<skill>/<helper>.cjs [--format json|pretty] approval-plan <resource> <action> [flags]
```

Normal commands should execute through the HybridClaw gateway by default and
return a live result. `--request` should emit the gateway-ready request without
executing it. `approval-plan` should validate a guarded action and return the
exact approved helper command to run later; it should not perform the action.

Prefer domain-level commands that match model workflows, such as
`device status`, `cover goto`, `invoice download`, or `ticket update`, over
raw `request` commands. Keep a generic escape hatch only when the underlying
API has many safe read methods that cannot all be wrapped individually.

### Tools And Surfaces To Use

Skill instructions should tell the model which existing HybridClaw surfaces to
use:

- `bash` runs local helper scripts and is the normal execution surface for
  bundled `*.cjs` helpers.
- `http_request` is for direct HTTP calls when no helper exists or for
  helper-emitted request objects in debugging paths. Prefer the helper for
  normal API work.
- `web_fetch`, `web_search`, or browser tools can be used to inspect official
  API documentation while authoring or repairing a skill, not as the runtime
  API client when the helper already covers the operation.
- `/policy`, `hybridclaw policy ...`, and `/admin/network-policy` manage workspace
  network policy for HTTP access.
- `hybridclaw gateway status` distinguishes stale builds, gateway PID state,
  sandbox mode, and runtime version before diagnosing gateway behavior.
- `hybridclaw skill list`, `skill inspect`, and `skill setup` are the operator
  surfaces for availability and declared dependencies.

### Approvals And Safety

Make read/write boundaries explicit:

- green operations are read-only or local formatting/planning.
- amber operations change external state and require explicit operator
  approval before the helper command includes its grant flag.
- red operations are unsupported through the skill, even if the upstream API
  exposes them.

For amber commands, the helper should reject execution unless an explicit grant
flag is present. The skill should instruct the model to first produce an
approval plan, then wait for a later operator confirmation, then run the exact
approved helper command unchanged.

### Secrets And Credentials

Never ask the model to paste raw credentials into prose or helper arguments.
Use runtime secret references:

- `bearerSecretName` for bearer tokens
- `secretHeaders` for named headers
- `<secret:NAME>` placeholders for URLs or bodies when the gateway must
  replace values
- `captureResponseFields` when an OAuth/token exchange should save a returned
  field into runtime secrets

Document credential names and where the operator gets them, but keep the helper
responsible for injecting them. When a token is domain-bound, preserve that
binding and do not broaden it in skill prose.

Use `config_variables:` frontmatter for non-secret values that should be
discoverable and persisted, for example inverter IPs, local host URLs, account
ids, or usernames. These values are plaintext and model-visible; operators set
them with `/env set NAME value` in chat or `hybridclaw env set NAME value` on a
local CLI, and helpers should reference them with gateway-resolved
`<env:NAME>` placeholders. Values that contain passwords, tokens, API keys, or
signing material belong in `credentials:` with `secret_ref`, not in
`config_variables:`.

Every skill setup section that mentions `hybridclaw env set`, `hybridclaw env
list`, `hybridclaw secret set`, or `hybridclaw secret list` must also include
the browser or slash-command equivalent (`/env ...` or `/secret ...`) for
operators using chat surfaces without CLI access. When a skill depends on
credentials, advise operators to set or update runtime secrets in this order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/credentials?tab=secrets`.
2. Browser `/chat` or TUI: run `/secret set NAME value`.
3. Local console fallback: run `hybridclaw secret set NAME value`.

For user-invocable chat skills, put browser-admin and slash-command guidance in
frontmatter `how_to_obtain` text and the first setup example; keep
`hybridclaw ...` commands only in a clearly labeled local-terminal alternative.
Do not tell chat users to run local CLI diagnostics when a gateway error or
operator-provided slash-command output already identifies the missing value.

### Network And Gateway Failures

Skills should classify failures by layer instead of guessing:

- model/provider unavailable: the agent may fail before any helper command
  runs
- gateway unreachable: helper cannot reach the local gateway URL
- policy denied: the gateway returns a network policy or allowlist error before
  opening the outbound request
- outbound connection failure: the gateway accepted policy but the process
  could not connect to the target
- upstream API error: the remote service returned an HTTP or API-level error

Do not infer container isolation, stale code, DNS problems, or bad credentials
without checking the relevant state. For gateway behavior, inspect
`hybridclaw gateway status`, current logs, and the helper/gateway error body.
For local LAN devices on macOS, Local Network privacy or NECP can block the app
that launched the gateway; confirm direct LAN access from the same launcher
before blaming the API helper.

### Testing Expectations

Bundled skills with helpers should have focused tests that lock down:

- frontmatter parsing and catalog metadata
- helper `--help` output and public command surface
- request construction for read and write operations
- approval-plan output and grant enforcement
- secret-reference emission without raw secret leakage
- live-execution wrapper behavior with mocked gateway responses
- error classification for gateway, policy, network, and upstream failures
- important `SKILL.md` invariants such as forbidden operations and route
  selection rules

When adding a helper command, update both the helper tests and the helper
surface listed in `SKILL.md`. When fixing a model misuse pattern, prefer a
helper/API change plus a regression test over a prompt-specific sentence.

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
  ZIP upload, explicit overwrite with `--force`, and adaptive-skill review

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

A skill can also constrain automatic model routing in its frontmatter:

```yaml
routing:
  minTier: general
  sensitivity: confidential
```

`minTier` must name a configured routing tier and becomes the invoked turn's
minimum rung. `sensitivity` is resolved through
`routing.sensitivityZones`; an unmapped label fails closed to the `local`
zone. These limits only narrow eligibility and never override an explicit
sovereignty maximum.

See [How to Ship a Business Skill](../guides/skills/business-skills.md) for the
operator-facing packaging contract.

## Adaptive Skills

Observation, inspection, and guarded amendment workflows are configured under
`adaptiveSkills.*` and documented in [Adaptive Skills](./adaptive-skills.md).
