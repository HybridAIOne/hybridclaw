---
title: Developer Guide
description: Runtime and maintainer-facing architecture, testing, and release documentation.
sidebar_position: 1
---

# Developer Guide

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
- [Secret Threat Model](./threat-model.md) for credential-adjacent feature
  review, model-leakage paths, and PR checklist expectations
- [Identity](./identity.md) for canonical user/agent IDs, authority boundaries,
  and discovery records
- [Workflows](./workflows.md) for declarative YAML workflow schema and validation rules
- [Harness Evolution](./harness-evolution.md) for eval-driven coworker
  workspace evolution loops, example suites, and admin inspection
- [Desktop Release Builds](./desktop-release.md) for signed macOS Electron
  packaging, notarization, and GitHub Release uploads
