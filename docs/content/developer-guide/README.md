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
- [ISO/IEC 27001 Control Matrix](./iso27001-control-matrix.md) for Annex A
  evidence mapping, repo-visible gaps, TISAX fit, and next evidence to collect
- [ISO/IEC 42001 AIMS Readiness](./iso42001-aims-readiness.md) for AI
  management-system scope, gap mapping, and implementation work items
- [ISO/IEC 42001 Evidence Templates](./iso42001-aims-evidence-templates.md)
  for AI system inventory, AI risk, impact assessment, provider review, eval,
  incident, and management review records
- [Admin Access Control](./admin-access-control.md) for scoped admin role
  bundles, session claims, and access-review evidence
- [ISO 27001 Evidence Package](./iso27001/) for SoA, risk register, asset
  inventory, access control, owners, review cadence, and sign-off trail
- [Identity](./identity.md) for canonical user/agent IDs, authority boundaries,
  and discovery records
- [Workflows](./workflows.md) for declarative YAML workflow schema and validation rules
- [Harness Evolution](./harness-evolution.md) for eval-driven coworker
  workspace evolution loops, example suites, and admin inspection
- [Desktop Release Builds](./desktop-release.md) for signed macOS Electron
  packaging, notarization, and GitHub Release uploads
