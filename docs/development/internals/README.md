---
title: Internals
description: Runtime and maintainer-facing architecture, testing, and release documentation.
sidebar_position: 1
---

# Internals

These pages focus on how HybridClaw is built and operated under the hood.

## In This Section

- [Architecture](./architecture.md) for the major runtime pieces and data flow
- [Runtime Internals](./runtime.md) for sandboxing, diagnostics, audit, and
  operational behavior
- [Approvals](./approvals.md) for traffic-light policy, trust scopes, and
  local-only command surfaces
- [Memory](./memory.md) for the built-in memory layers, prompt injection path,
  and compaction/consolidation lifecycle
- [Session Routing](./session-routing.md) for canonical session keys and
  linked-identity boundaries
