---
title: How to Ship a Business Skill
description: Package, declare, install, upgrade, disable, uninstall, and roll back production business skills.
sidebar_position: 9
---

# How to Ship a Business Skill

A business skill is a versioned `SKILL.md` package that declares what work it
can perform, which credentials it needs, which channels it supports, and how
operators manage its lifecycle.

## Package Layout

Use one directory per skill:

```text
deal-desk/
  SKILL.md
  scripts/
    prepare-packet.js
  README.md
```

`SKILL.md` is the manifest and instruction entrypoint. Keep package scripts and
templates inside the skill directory so lifecycle snapshots can roll back the
whole package.

## Manifest Schema

Production business skills should declare the manifest fields in frontmatter:

```yaml
---
name: deal-desk
description: Prepare CRM-backed deal desk packets.
manifest:
  id: deal-desk
  version: 1.2.3
  capabilities:
    - crm.sync
    - proposal.write
  required_credentials:
    - id: salesforce
      env: SALESFORCE_TOKEN
      description: Read opportunity and account data
  supported_channels:
    - slack
    - email
metadata:
  hybridclaw:
    category: productivity
    short_description: Prepare deal desk packets from CRM context.
    install:
      - id: node-deps
        kind: npm
        package: "@example/deal-desk-cli"
        bins: ["deal-desk"]
---
```

Required fields for business packages:

| Field | Purpose |
|---|---|
| `manifest.id` | Stable package id used in lifecycle records |
| `manifest.version` | Semver package version |
| `manifest.capabilities` | Work surfaces the skill is allowed to perform |
| `manifest.required_credentials` | Credential ids and optional env vars the operator must provide |
| `manifest.supported_channels` | Channels where the skill may be loaded |

`web` is normalized to `tui` for local browser sessions. Unknown channels are
ignored.

## Lifecycle Commands

Use lifecycle commands for packages:

```bash
hybridclaw skill install ./deal-desk
hybridclaw skill upgrade ./deal-desk
hybridclaw skill disable deal-desk
hybridclaw skill enable deal-desk
hybridclaw skill uninstall deal-desk
hybridclaw skill revisions deal-desk
hybridclaw skill rollback deal-desk <revision-id>
```

`skill install <skill> <dependency>` remains the dependency installer for
`metadata.hybridclaw.install` entries.

## Audit And Rollback

Lifecycle commands write structured audit records under the runtime audit data
directory and update `skills.installed` in runtime config. Runtime config
revisions track the package registry, and skill package snapshots are stored in
the existing `runtime-config-revisions` database with asset type `skill`.

Rollback restores the packaged skill directory from a recorded snapshot, then
updates the installed manifest record.

## Policy

Skill use is controlled by the same runtime policy surfaces as other skill
availability:

- `skills.disabled` blocks a skill globally
- `skills.channelDisabled.<channel>` blocks a skill in one channel
- `manifest.supported_channels` prevents unsupported channels from loading the
  skill into the agent prompt
- `skills.autonomy` records per-agent autonomy policy for skill use decisions

For production packages, keep capabilities narrow and credentials explicit. Do
not hide broad side effects inside generic capabilities such as `automation`.
