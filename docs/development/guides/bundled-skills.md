---
title: Bundled Skills
description: Notable built-in skills, install helpers, and skill management commands.
sidebar_position: 4
---

# Bundled Skills

HybridClaw currently ships with 34 bundled skills. A few notable categories:

- office workflows: `pdf`, `xlsx`, `docx`, `pptx`, `office-workflows`
- planning and engineering: `project-manager`, `feature-planning`,
  `code-review`, `code-simplification`
- visual explainers and animation: `manim-video`, `excalidraw`
- platform integrations: `github-pr-workflow`, `notion`, `trello`, `stripe`,
  `wordpress`, `google-workspace`, `discord`
- knowledge workflows: `llm-wiki`, `obsidian`, `zettelkasten`
- personal and Apple workflows: `apple-calendar`, `apple-passwords`,
  `apple-music`
- marketplace and automation workflows: `sokosumi`
- runtime utilities: `hybridclaw-help`, `current-time`, `personality`,
  `channel-catchup`

## Commands

```bash
hybridclaw skill list
hybridclaw skill install 1password brew
hybridclaw skill enable <name>
hybridclaw skill disable <name>
hybridclaw skill inspect <name>
```

`hybridclaw skill list` groups bundled, imported, and higher-precedence
personal/project skills by category and shows missing dependencies inline.
Skills can be disabled globally or per channel kind (`discord`, `msteams`,
`whatsapp`, `email`) through `hybridclaw skill enable|disable ...` or the
TUI `/skill config` screen. The admin `Skills` page uses the same category
metadata for filtering, review, and local skill authoring.

For per-skill descriptions, prerequisites, example prompts, and
troubleshooting, see the [Skills Catalog](./skills/README.md).

For the underlying resolution rules and runtime behavior, see
[Skills Internals](../extensibility/skills.md).
