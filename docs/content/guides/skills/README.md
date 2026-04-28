---
title: Skills Catalog
description: Per-skill reference with descriptions, prerequisites, installation, tips, example prompts, and troubleshooting.
sidebar_position: 1
---

# Skills Catalog

HybridClaw ships **37 bundled skills** across eight categories. Each page below
covers every skill in its category with prerequisites, install commands,
tips & tricks, ready-to-try example prompts, and troubleshooting.

For CLI management commands see [Bundled Skills](../bundled-skills.md); for
resolution rules and runtime internals see
[Skills Internals](../../extensibility/skills.md).
For production package requirements see
[How to Ship a Business Skill](./business-skills.md).

> **Quick install pattern** — most skills work out of the box. When a skill
> needs a host-side dependency, install it with:
>
> ```bash
> hybridclaw skill install <skill> <dependency-id>
> ```

## Categories

| Category | Skills | Page |
|---|---|---|
| Office | pdf, xlsx, docx, pptx, office-workflows | [Office Skills](./office.md) |
| Development | code-review, gh-issues, github-pr-workflow, salesforce, skill-creator | [Development Skills](./development.md) |
| Communication | discord, channel-catchup | [Communication Skills](./communication.md) |
| Apple | apple-calendar, apple-music, apple-passwords | [Apple Skills](./apple.md) |
| Productivity | feature-planning, project-manager, trello | [Productivity Skills](./productivity.md) |
| Memory & Knowledge | llm-wiki, notion, obsidian, personality, zettelkasten | [Memory & Knowledge Skills](./memory-knowledge.md) |
| Publishing | excalidraw, manim-video, wordpress, write-blog-post | [Publishing Skills](./publishing.md) |
| Integrations & Utilities | 1password, stripe, sokosumi, gog, google-workspace, current-time, hybridclaw-help, iss-position | [Integrations & Utilities](./integrations.md) |

## Evaluating Example Prompts

The 🎯 **Try it yourself** prompts on each skill page double as fixtures for
the `hybridai-skills` eval suite. When you add or rename a prompt, the eval
picks up the change automatically — no separate fixture file to keep in sync.

```bash
hybridclaw eval hybridai-skills setup                   # harvest fixtures from these pages
hybridclaw eval hybridai-skills list --skill code-review
hybridclaw eval hybridai-skills run --dry-run           # validate fixture shape + skill existence
hybridclaw eval hybridai-skills run --max 3             # live-run against the local gateway
```

The runner grades each prompt by inspecting the model's tool trace with the
same `resolveObservedSkillName` oracle the gateway uses, so "skill X was
activated" means the same thing here as in production. See
[Commands → Local Eval Workflows](../../reference/commands.md#local-eval-workflows)
for the full surface.
Use `hybridclaw eval hybridai-skills run --explicit ...` when you want the
runner to rewrite each prompt as `/<skill> ...` and compare explicit
invocation against the natural-language prompt path. Live summaries also show
the observed skill, whether artifacts were produced, and counted tool-call
totals for each prompt.

## Internal Skills

The following skills are used internally by HybridClaw and are not directly
invocable:

| Skill | Purpose |
|---|---|
| `office` | Shared OOXML helper scripts for DOCX/XLSX/PPTX unpacking and repacking |
| `code-simplification` | Behavior-safe refactoring, activated during code-review workflows |
