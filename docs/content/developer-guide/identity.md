---
title: Identity
description: Canonical identity formats, authority boundaries, and discovery records.
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

Agent registry records persist two canonical fields:

- `canonicalId`: the stable `agent-slug@user@instance-id` identity for the agent
- `ownerUserId`: the canonical `username@authority` owner user ID used when the local identity is first derived

Existing local agents are backfilled on first database migration. Agents with no
federated owner use the `local` user authority, so an owner like `benedikt`
becomes `benedikt@local`. Bare local agent slugs remain accepted inside the same
instance; A2A boundaries resolve them to the persisted `canonicalId`.

## A2A Envelope Federation Metadata

A2A envelopes carry canonical `sender_agent_id` and `recipient_agent_id`
values when they cross instance boundaries. The sender instance is also exposed
as `sender_instance_id` so transport headers, idempotency checks, and audit
queries can index it without reparsing the agent identity string. If
`sender_instance_id` is omitted and `sender_agent_id` is canonical, envelope
validation derives it from the embedded `instance-id`. If both are present, they
must match.

The idempotency tuple for persisted A2A envelopes is
`(envelope.id, sender_instance_id)`. Existing local envelopes without the
explicit field remain valid and hydrate with compatibility
`sender_instance_id: "local"` when read. Persisted canonical sender IDs receive
the derived instance from `sender_agent_id`. Neither migration path rewrites
thread state just to add the derived field.

Lookup APIs that address a single persisted envelope should use the same tuple.
`getA2AEnvelope(threadId, envelopeId)` remains valid while the ID is unique
within a thread, but callers must pass `sender_instance_id` when a federated
thread can contain the same envelope ID from multiple sender instances.

Delegation fields are a strict overlay on the federation base:
`source_instance_id`, `target_instance_id`, and `delegation_token` are provided
together for delegated handoffs. `source_instance_id` must match
`sender_instance_id` and the instance portion of `sender_agent_id`.

## Identity Discovery

Federated peers can resolve canonical user or agent IDs through DNS-style TXT
records. `identityDiscoveryDnsName(canonicalId, zone)` hashes the normalized ID
with SHA-256/base64url and looks up:

```text
_hybridclaw-id.<identity-hash>.<zone>
```

TXT record values are JSON objects:

```json
{
  "canonicalId": "support-lena@acme@inst-7f3a",
  "url": "https://bot.example.com",
  "publicKey": "test-public-key"
}
```

`IdentityResolver` validates the canonical ID, normalizes the URL, deduplicates
concurrent cold-cache lookups, caches successful records for five minutes by
default, and supports explicit invalidation. Discovery URLs must use HTTPS
unless they target loopback.

The A2A outbound outbox uses this resolver automatically when
`HYBRIDCLAW_IDENTITY_DISCOVERY_ZONE` is set. Remote `sendMessage` recipients are
queued first, then the outbox resolves the recipient's canonical ID under that
zone before dispatching through the A2A HTTP transport. The synchronous
`sendMessage` confirmation reports `pending` for durable queued delivery and
`false` only when dispatch is refused before an outbox item exists; later
outbox failures are audited and routed through interactive escalation.
