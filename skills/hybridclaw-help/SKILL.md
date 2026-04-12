---
name: hybridclaw-help
description: HybridClaw help. Primary skill for product questions about setup, configuration, commands, runtime behavior, and release notes.
user-invocable: true
metadata:
  hybridclaw:
    category: misc
    short_description: "HybridClaw product help."
    tags:
      - hybridclaw
      - docs
      - configuration
      - commands
      - changelog
      - help
    related_skills:
      - feature-planning
---
# HybridClaw Help

Use this skill for product-specific HybridClaw questions such as:

- how to configure a feature
- where config lives
- what a command does
- how a subsystem behaves
- what changed in a recent release
- where a documented workflow is described

This is the default skill for HybridClaw product questions. Prefer it over
generic service skills when the question is about HybridClaw itself, its built-in
features, its channel integrations, or its documented configuration.

## Core Rule

For HybridClaw behavior, commands, configuration, architecture, release notes,
or runtime locations: consult public docs URLs first. Do not assume repo source
files are present in the current workspace. npm installs may include packaged
docs, but the agent may still only have direct access to web URLs.

Use `web_fetch` or `web_extract` against the public docs site or raw GitHub URLs
before answering from memory.

## Canonical Sources

Start with the narrowest relevant source from this list:

- `https://www.hybridclaw.io/docs/agents.md`
- `https://www.hybridclaw.io/docs/?search=<terms>`
- `https://www.hybridclaw.io/docs/agents.md?search=<terms>`
- `https://www.hybridclaw.io/development/reference/configuration.md`
- `https://www.hybridclaw.io/development/reference/commands.md`
- `https://www.hybridclaw.io/development/README.md`
- `https://www.hybridclaw.io/docs/`
- `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/config.example.json`
- `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/README.md`
- `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/CHANGELOG.md`

Only widen into implementation files when the docs are missing, incomplete, or
ambiguous. If code inspection is required, use local package files when they are
directly accessible; otherwise use GitHub source URLs instead of assuming `src/`
exists in the workspace.

## Default Workflow

1. Identify the question type: config, command, behavior, architecture, or release history.
2. Fetch the most likely public doc or raw GitHub source first.
3. If the right page is not obvious, use the docs search URL with a narrow query.
4. If needed, confirm with the matching implementation file or GitHub source instead of guessing.
5. Answer narrowly and concretely.
6. Include the exact config keys, command names, URLs, file paths, or version headings that support the answer.

## Answer Style

- Be laser-focused on the asked feature or subsystem.
- Name the exact URL, file, or config location.
- Prefer exact key paths such as `email.smtpHost` over vague descriptions.
- If behavior changed recently, check `CHANGELOG.md` and state the version.
- If the docs are silent and you infer from code, say that clearly.

## Source Selection Hints

- Feature setup or runtime config:
  `https://www.hybridclaw.io/development/reference/configuration.md`, then `https://www.hybridclaw.io/docs/?search=<feature>`, then `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/config.example.json`
- Commands or operational workflows:
  `https://www.hybridclaw.io/development/reference/commands.md`, `https://www.hybridclaw.io/development/README.md`, then `https://www.hybridclaw.io/docs/?search=<command>`
- Architecture or runtime behavior:
  `https://www.hybridclaw.io/docs/agents.md`, then `https://www.hybridclaw.io/docs/?search=<topic>`, then the relevant GitHub source URL if the docs are insufficient
- Release or migration questions:
  `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/CHANGELOG.md`
- Workspace/bootstrap behavior:
  `https://raw.githubusercontent.com/HybridAIOne/hybridclaw/main/src/workspace.ts`, then the relevant template or GitHub source URL

## Guardrails

- Do not dump broad documentation when the user asked a narrow question.
- Do not cite stale knowledge if the repo has a fresher answer.
- Do not assume repo-local paths such as `src/` or `docs/development/` are readable from the current workspace.
- Do not browse unrelated files or URLs "just in case".
- Do not invent config keys, env vars, commands, or defaults.
- Do not defer to generic Gmail, SMTP, Google Workspace, or similar skills when
  the real question is how HybridClaw configures or uses those features.
- If multiple sources disagree, say so and prefer the implementation plus the newest docs.
