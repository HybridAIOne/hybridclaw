---
title: Bundled Skills
description: Notable built-in skills, install helpers, and skill management commands.
sidebar_position: 4
---

# Bundled Skills

HybridClaw ships with 50+ bundled skills. A few notable categories:

- office workflows: `pdf`, `xlsx`, `docx`, `pptx`, `office-workflows`
- planning and engineering: `project-manager`, `feature-planning`, `code-review`, `code-simplification`, `gh-issues`, `warehouse-sql`
- visual explainers, image, video, and speech: `diagram`, `manim-video`, `excalidraw`, `image-generation`, `video-generation`, `video.from-script`, `speech.transcribe`, `speech.detect-language`
- platform integrations: `github-pr-workflow`, `notion`, `trello`, `stripe`, `download-platform-invoices`, `wordpress`, `gog`, `google-workspace`, `google-ads`, `ga4`, `airtable`, `fastbill`, `firecrawl`, `heygen`, `hermes3000-writing`, `discord`
- infrastructure and DevOps: `hetzner-cloud`, `hetzner-dns`, `hetzner-storage-box`, `warehouse-sql`
- knowledge workflows: `llm-wiki`, `obsidian`, `zettelkasten`
- search workflows: `search.web`, `search.news`, `search.images`
- personal and Apple workflows: `apple-calendar`, `apple-passwords`, `apple-music`
- marketplace and automation workflows: `sokosumi`
- runtime utilities: `hybridclaw-help`, `current-time`, `personality`, `channel-catchup`

## Commands

```bash
hybridclaw skill list
hybridclaw skill install 1password op
hybridclaw skill enable <name>
hybridclaw skill disable <name>
hybridclaw skill list blocked
hybridclaw skill unblock <name>
hybridclaw skill inspect <name>
```

`hybridclaw skill list` groups bundled, imported, and higher-precedence
personal/project skills by category and shows missing dependencies inline.
Skills can be disabled globally or per channel kind (`discord`, `msteams`,
`whatsapp`, `email`) through `hybridclaw skill enable|disable ...` or the
TUI `/skill config` screen. The admin `Skills` page uses the same category
metadata for filtering, review, and local skill authoring.

If the scanner blocks an imported or workspace skill, review
`hybridclaw skill list blocked` before taking action. `hybridclaw skill unblock
<name>` and the Admin Skills page record a scanner-bypass marker for that
installed copy only; they do not change the source skill package.

For per-skill descriptions, prerequisites, example prompts, and
troubleshooting, see the [Skills Catalog](./skills/README.md).

For the underlying resolution rules and runtime behavior, see
[Skills Internals](../extensibility/skills.md).
