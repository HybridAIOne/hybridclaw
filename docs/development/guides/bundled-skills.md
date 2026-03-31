---
title: Bundled Skills
description: Notable built-in skills, install helpers, and skill management commands.
sidebar_position: 4
---

# Bundled Skills

HybridClaw currently ships with 30 bundled skills. A few notable categories:

- office workflows: `pdf`, `xlsx`, `docx`, `pptx`, `office-workflows`
- planning and engineering: `project-manager`, `feature-planning`,
  `code-review`, `code-simplification`
- platform integrations: `github-pr-workflow`, `notion`, `trello`, `stripe`,
  `wordpress`, `google-workspace`, `discord`
- personal and Apple workflows: `apple-calendar`, `apple-passwords`,
  `apple-music`
- marketplace and automation workflows: `sokosumi`

## Commands

```bash
hybridclaw skill list
hybridclaw skill install pdf [install-id]
hybridclaw skill enable <name>
hybridclaw skill disable <name>
hybridclaw skill inspect <name>
```

Skills can be disabled globally or per channel kind (`discord`, `msteams`,
`whatsapp`, `email`) through `hybridclaw skill enable|disable ...` or the TUI
`/skill config` screen.

For the underlying resolution rules and runtime behavior, see
[Skills Internals](../extensibility/skills.md).
