---
title: Supplier Register
description: Initial supplier and cloud-service register for HybridClaw.
sidebar_position: 9
---

# Supplier Register

Review date: 2026-06-16.

| Supplier/service | Use | Data categories | Owner | Review evidence needed | Exit plan |
| --- | --- | --- | --- | --- | --- |
| GitHub | Source control, issues, CI, releases | Source, build logs, issue metadata | Supplier Owner | Org security settings, branch protection, app permissions | Mirror repository and export releases/issues. |
| npm registry | Package publishing and dependency retrieval | Package metadata, provenance | Engineering Owner | Trusted publishing, tokenless publish evidence | Publish freeze and alternate registry/cache. |
| GHCR/Docker registry | Container image distribution | Image metadata, SBOM/provenance when enabled | Engineering Owner | Image provenance/SBOM settings | Rebuild and publish to alternate registry. |
| HybridAI | Model/API provider | Prompts, responses, account metadata | Supplier Owner | DPA/security review, data-processing settings | Switch provider config or self-hosted provider. |
| OpenAI/Anthropic/other model providers | Optional model providers | Prompts, responses, account metadata | Supplier Owner | DPA/security review per provider | Disable provider and rotate credentials. |
| Discord/Slack/Telegram/email/WhatsApp/MSTeams | Optional channels | Messages, files, user identifiers | Supplier Owner | DPA/security review per enabled channel | Disable channel and export relevant records. |
| Cloud/hosting provider | Operator deployment | Runtime data, logs, backups | Operations Owner | Hosting security controls, location, backup evidence | Restore backup to alternate host. |
| Package dependencies | Runtime and build dependencies | Code executed in build/runtime | Engineering Owner | Dependency review, vulnerability triage | Pin, patch, replace, or vendor reviewed code. |
