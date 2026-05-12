---
title: Architecture
description: High-level map of the HybridClaw runtime, the four-layer principle, repository layout, and core data flows.
sidebar_position: 2
---

# Architecture

## The Four-Layer Principle

HybridClaw follows a directional four-layer architecture. Every design decision
should move intelligence **up** and execution **down**, keeping the middle
layers as thin as possible.

```text
┌─────────────────────────────────────────────────────┐
│  Skills                                             │
│  Markdown procedures that encode judgment, process, │
│  and domain knowledge. This is where 90% of the     │
│  value lives.                                       │
├─────────────────────────────────────────────────────┤
│  Plugins                                            │
│  Composable runtime extensions that bridge skills   │
│  and tooling. They wire external systems into the   │
│  runtime — memory providers, inbound webhooks,      │
│  prompt hooks — without bloating the core harness.  │
├─────────────────────────────────────────────────────┤
│  Core Harness                                       │
│  The thin orchestration layer. Routes messages,     │
│  manages sessions, enforces the tool loop. JSON in, │
│  text out. Keep it minimal and read-only by default.│
├─────────────────────────────────────────────────────┤
│  Deterministic Tooling                              │
│  bash_exec, glob_search, pdf_read, web_fetch,       │
│  browser_action — the reliable foundation.          │
│  Fixed contracts, predictable behavior, no judgment.│
└─────────────────────────────────────────────────────┘
```

### The principle is directional

- **Push intelligence up** into skills. When you find yourself encoding
  judgment, heuristics, or decision trees in TypeScript, ask whether a SKILL.md
  could teach the model to make that decision instead. Every model improvement
  then automatically improves every skill.
- **Push integration sideways** into plugins. When a new external system needs
  to participate in the runtime — memory, retrieval, delivery, webhooks — it
  should be a plugin, not new gateway code. Plugins are composable and
  removable; harness code is permanent.
- **Push execution down** into deterministic tooling. Tools have fixed schemas,
  predictable side effects, and no judgment. They do exactly what the model
  asks, nothing more.
- **Keep the harness thin.** The core harness should do only what no other
  layer can: route messages between channels and the container, manage session
  state, and enforce the tool loop. Resist the pull to add intelligence or
  integration logic here.

### How to decide where something belongs

| If the new code...                          | It belongs in...         |
|---------------------------------------------|--------------------------|
| Teaches the model *when* or *how* to act    | A skill (SKILL.md)       |
| Wires an external system into the runtime   | A plugin                 |
| Routes, persists, or enforces the tool loop | The core harness         |
| Executes a deterministic action on request  | Deterministic tooling    |

## Runtime Components

- `gateway` is the core runtime process. It owns persistence, scheduler,
  heartbeat, HTTP APIs, and channel integrations.
- `tui` is a thin terminal client that talks to the running gateway over HTTP.
- `container/` holds the sandboxed runtime that executes tools and model calls.
- `plugins/` holds composable extensions that bridge skills and core tooling.
- `src/a2a/` holds the agent-to-agent envelope model, peer descriptors,
  transport registry, JSON-RPC Agent Card adapter, webhook adapter, and retrying
  outbound outbox.
- Communication between host and sandbox uses file-based IPC.

## Repository Structure

```text
skills/                           SKILL.md skills and supporting assets
                                  (intelligence layer)
community-skills/                 External contributed skills
plugins/                          Composable runtime extensions — memory
                                  providers, retrieval, webhooks, email
src/                              Core CLI, gateway, auth, providers, audit,
                                  scheduler, memory, and runtime wiring
src/channels/                     Channel transports (Discord, Slack, etc.)
src/gateway/                      Gateway lifecycle, API, health, and service
container/src/                    Sandboxed runtime, tool execution, provider
                                  adapters, and IPC handling
                                  (deterministic tooling layer)
templates/                        Workspace bootstrap files seeded at runtime
tests/                            Vitest suites across unit/integration/e2e/live
docs/                             Static web assets and maintainer docs
```

## Agent Workspace Bootstrap

Each HybridClaw agent workspace is seeded with bootstrap context files:

- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `MEMORY.md`
- `AGENTS.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `BOOT.md`

These templates are copied from `templates/` into the agent workspace by
`src/workspace.ts`. Turn transcript mirrors live under
`<workspace>/.session-transcripts/*.jsonl`.

Treat `templates/` as product runtime inputs. Contributor docs should live in
the repo root or `docs/content/`, not in the bootstrap templates.
