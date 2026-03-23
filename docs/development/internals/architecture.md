---
title: Architecture
description: High-level map of the HybridClaw runtime, repository layout, and core data flows.
sidebar_position: 2
---

# Architecture

## Runtime Components

- `gateway` is the core runtime process. It owns persistence, scheduler,
  heartbeat, HTTP APIs, and optional Discord integration.
- `tui` is a thin terminal client that talks to the running gateway over HTTP.
- `container/` holds the sandboxed runtime that executes tools and model calls.
- Communication between host and sandbox uses file-based IPC.

## Repository Structure

```text
src/                              Core CLI, gateway, auth, providers, audit,
                                  scheduler, memory, and runtime wiring
src/channels/discord/             Discord transport, delivery, and policy logic
src/gateway/                      Gateway lifecycle, API, health, and service
container/src/                    Sandboxed runtime, tool execution, provider
                                  adapters, and IPC handling
skills/                           Bundled SKILL.md skills and supporting assets
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
the repo root or `docs/development/`, not in the bootstrap templates.
