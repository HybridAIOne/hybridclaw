---
title: Identity
description: Canonical user identity formats and authority boundaries.
sidebar_position: 7
---

# Identity

## User IDs

HybridClaw canonical user IDs use this format:

```text
username@authority
```

Examples:

```text
lena@hybridai
operator@local
sam.dev@example-authority
```

The canonical form is lowercase ASCII. Both `username` and `authority` must:

- start with a lowercase letter or digit
- contain only lowercase letters, digits, dots, underscores, or hyphens
- be 1-128 characters long

The `@` separator is required and may appear exactly once. Display names,
transport-specific IDs, email addresses, phone numbers, and agent IDs are not
canonical user IDs unless they have first been mapped into this format.

## Authorities

Authorities scope usernames. The same username under two authorities identifies
two different users.

HybridClaw reserves these authorities:

- `hybridai`: canonical HybridAI-hosted user authority and the default used by `formatUserId(username)`
- `local`: un-federated single-instance authority for local-only operators or demos

Other authorities are valid when a federated identity provider or deployment
owns that namespace.

## Helpers

Use `parseUserId()` and `formatUserId()` from `src/identity/user-id.ts` at
boundaries instead of hand-parsing strings. Use `userIdsEqual()` or
`compareUserIds()` when comparing IDs so case and whitespace are normalized
before comparison.

## Agent Identities

HybridClaw canonical agent identities use this format:

```text
agent-slug@user@instance-id
```

Examples:

```text
support-lena@acme@inst-7f3a
main@local@inst-550e8400-e29b-41d4-a716-446655440000
research.agent@team_1@local-dev
```

The canonical form is lowercase ASCII. `agent-slug`, `user`, and
`instance-id` must:

- start with a lowercase letter or digit
- contain only lowercase letters, digits, dots, underscores, or hyphens
- be 1-128 characters long

The `@` separator is required and must appear exactly twice. The `user`
component is a routing slug derived from the agent owner or local operator, not
an embedded `username@authority` user ID.

Local HybridClaw instances allocate `instance-id` on first use and persist it
under the runtime home at `identity/instance-id.json`. Auto-allocated IDs are
UUID-backed and use the `inst-<uuid>` form. Once allocated, the same instance ID
is reused for every local agent identity so remote peers can distinguish one
stable runtime instance from another. Operators may set `HYBRIDCLAW_INSTANCE_ID`
for explicit deployments; in that case the configured component is used as-is
after normalization and no local state file is written.

Use `parseAgentIdentity()` and `formatAgentIdentity()` from
`src/identity/agent-id.ts` at boundaries instead of hand-parsing strings. Use
`resolveLocalInstanceId()` for local allocation and
`slugifyAgentIdentityComponent()` when deriving a canonical component from a
display name, config value, or environment value.
