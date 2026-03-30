---
name: hybridclaw-help
description: Use this skill when the user asks how HybridClaw works, how to configure a feature, where a setting lives, what command to run, what changed recently, or other product-specific HybridClaw questions that should be answered from the current docs and repo.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - hybridclaw
      - docs
      - configuration
      - commands
      - changelog
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

## Core Rule

For HybridClaw behavior, commands, configuration, architecture, release notes,
or runtime locations: consult local docs first. Do not answer from memory when a
current repo source can answer the question directly.

## Canonical Sources

Start with the narrowest relevant source from this list:

- `docs/development/reference/configuration.md`
- `docs/development/`
- `config.example.json`
- `CHANGELOG.md`
- `README.md`
- `src/config/`
- `src/workspace.ts`
- `src/gateway/`
- `templates/`

Prefer repo-local markdown and config files over paraphrasing from memory. If
the repo docs answer the question, use them. Only widen into implementation
files when the docs are missing, incomplete, or ambiguous.

## Default Workflow

1. Identify the question type: config, command, behavior, architecture, or release history.
2. Read the most likely canonical doc or config source first.
3. If needed, confirm with the matching implementation file instead of guessing.
4. Answer narrowly and concretely.
5. Include the exact config keys, command names, file paths, or version headings that support the answer.

## Answer Style

- Be laser-focused on the asked feature or subsystem.
- Name the exact file or config location.
- Prefer exact key paths such as `email.smtpHost` over vague descriptions.
- If behavior changed recently, check `CHANGELOG.md` and state the version.
- If the docs are silent and you infer from code, say that clearly.

## Source Selection Hints

- Feature setup or runtime config:
  `docs/development/reference/configuration.md`, `config.example.json`, then `src/config/`
- Commands or operational workflows:
  `README.md`, `docs/development/guides/`, `docs/development/reference/`
- Architecture or runtime behavior:
  `docs/development/internals/`, then the relevant `src/` module
- Release or migration questions:
  `CHANGELOG.md`
- Workspace/bootstrap behavior:
  `templates/`, `src/workspace.ts`

## Guardrails

- Do not dump broad documentation when the user asked a narrow question.
- Do not cite stale knowledge if the repo has a fresher answer.
- Do not browse unrelated files "just in case".
- Do not invent config keys, env vars, commands, or defaults.
- If multiple sources disagree, say so and prefer the implementation plus the newest docs.
