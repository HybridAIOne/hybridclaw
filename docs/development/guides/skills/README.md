---
title: Skills Catalog
description: Per-skill reference with descriptions, prerequisites, installation, tips, example prompts, and troubleshooting.
sidebar_position: 1
---

# Skills Catalog

HybridClaw ships **34 bundled skills** across nine categories. Each page below
covers every skill in its category with prerequisites, install commands,
tips & tricks, ready-to-try example prompts, and troubleshooting.

For CLI management commands see [Bundled Skills](../bundled-skills.md); for
resolution rules and runtime internals see
[Skills Internals](../../extensibility/skills.md).

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
| Development | code-review, github-pr-workflow, salesforce, skill-creator | [Development Skills](./development.md) |
| Communication | discord, channel-catchup | [Communication Skills](./communication.md) |
| Apple | apple-calendar, apple-music, apple-passwords | [Apple Skills](./apple.md) |
| Productivity | feature-planning, project-manager, trello | [Productivity Skills](./productivity.md) |
| Memory & Knowledge | llm-wiki, notion, obsidian, personality, zettelkasten | [Memory & Knowledge Skills](./memory-knowledge.md) |
| Publishing | manim-video, wordpress, write-blog-post | [Publishing Skills](./publishing.md) |
| Integrations & Utilities | 1password, stripe, sokosumi, google-workspace, current-time, hybridclaw-help, iss-position | [Integrations & Utilities](./integrations.md) |

## Internal Skills

The following skills are used internally by HybridClaw and are not directly
invocable:

| Skill | Purpose |
|---|---|
| `office` | Shared OOXML helper scripts for DOCX/XLSX/PPTX unpacking and repacking |
| `code-simplification` | Behavior-safe refactoring, activated during code-review workflows |
