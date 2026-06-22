---
title: Asset And Data Inventory
description: Initial ISO asset and data inventory for HybridClaw.
sidebar_position: 4
---

# Asset And Data Inventory

Review date: 2026-06-16.

| Asset | Type | Data categories | Location | Owner | Classification | Retention class | Backup class |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Source repository | Code | Source, docs, tests, policy | GitHub repository | Engineering Owner | Internal | Repository history | GitHub/operator |
| Gateway runtime | Service | Messages, tool requests, admin operations | Operator host | Operations Owner | Confidential | Operator-defined | Operator-defined |
| SQLite memory database | Data store | Sessions, memory, audit indexes, user IDs | `DATA_DIR` | Data Owner | Confidential / PII possible | Operator-defined | Required |
| Audit wire logs | Log store | Prompts, tool events, approvals, hashes | `data/audit/*/wire.jsonl` | Audit Owner | Confidential | Retain per policy | Required, off-host recommended |
| Runtime secret store | Secret store | Secret metadata and encrypted values | Operator host / mounted secret | Security Owner | Restricted | Until rotated/deleted | Required with key custody |
| Container workspace | Execution environment | Workspace files, tool outputs | Docker container mounts | Engineering Owner | Matches source data | Session/workspace lifecycle | Optional |
| Admin console | Web app | Admin API responses, no persisted web token | Browser + gateway | Access Owner | Confidential | Browser-memory token only | Not applicable |
| CI workflows | Build system | Build logs, dependency metadata | GitHub Actions | Engineering Owner | Internal | GitHub retention | GitHub/operator |
| Package registries | Supplier | Published packages, provenance metadata | npm, GHCR | Supplier Owner | Public/Internal | Registry retention | Registry |
| Provider integrations | Supplier/service | Prompts, responses, provider metadata | Provider APIs | Supplier Owner | Confidential / PII possible | Supplier/operator | Supplier/operator |
| Channel integrations | Supplier/service | Messages, attachments, identities | Discord, Slack, email, etc. | Supplier Owner | Confidential / PII possible | Supplier/operator | Supplier/operator |
| Uploaded media cache | Data store | User-provided files/images/audio/video | `DATA_DIR/uploaded-media-cache` | Data Owner | Confidential / PII possible | Operator-defined | Optional/required by use |

## Data Handling Notes

- Secrets must use runtime secret storage or approved external vaults.
- Browser admin tokens are not persisted by the console. Manual token entry is
  memory-only; local and HybridAI-launched sessions use HttpOnly cookies.
- Retention, backup, deletion, and subject-rights workflows need operator
  records before audit.
