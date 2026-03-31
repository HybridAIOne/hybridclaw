---
title: Session Routing
description: Canonical session keys, routing boundaries, and identity isolation across HybridClaw channels.
sidebar_position: 4
---

# Session Routing

## Canonical Keys

HybridClaw uses canonical session keys for transport-facing session identity.
The current canonical format is marker-based:

```text
agent:<agentId>:channel:<channelKind>:chat:<chatType>:peer:<peerId>
```

Optional segments may be appended in typed pairs:

```text
:thread:<threadId>
:topic:<topicId>
:subagent:<subagentId>
```

Values are normalized and URL-encoded when keys are built. Parsing is marker
based, not positional, so new typed segments can be added without redefining the
base grammar.

HybridClaw still accepts the older positional canonical shape
`agent:<agentId>:<channelKind>:<chatType>:<peerId>` for backward compatibility,
but new writes use the marker-based form.

## Key Classification

`classifySessionKeyShape()` distinguishes between:

- canonical keys
- malformed canonical keys
- known legacy session ids
- opaque caller-provided ids

Malformed canonical keys are rejected at the boundary instead of silently
falling back to legacy/opaque handling. This matters most for HTTP API callers
and DB compatibility lookup, where a truncated `agent:...` key would otherwise
look like a valid raw session id.

## Specific vs Main Session Scope

HybridClaw stores two related keys on each session row:

- `session_key`: the specific transport conversation
- `main_session_key`: the continuity scope used for current-session lookup and
  canonical memory windows

By default these are the same. They diverge only when session routing is
configured to collapse multiple DM aliases into one continuity scope.

This separation keeps transport identity explicit while still allowing
cross-channel continuity where the operator has intentionally linked identities.

## DM Isolation

`sessionRouting.dmScope` controls how HybridClaw derives `main_session_key` for
direct messages.

### `per-channel-peer`

This is the default and the safe multi-user setting. DM continuity stays scoped
to the exact channel kind and peer identity:

- Discord DMs do not share context with email
- Teams DMs do not share context with WhatsApp
- different users on the same channel kind do not share context

### `per-linked-identity`

This mode collapses linked aliases onto a synthetic main session key:

```json
{
  "sessionRouting": {
    "dmScope": "per-linked-identity",
    "identityLinks": {
      "user_a": ["discord:user-123", "email:user_a@example.com"]
    }
  }
}
```

In that example, the Discord DM and email DM keep distinct `session_key`
values, but they share a `main_session_key` derived from `user_a`.

Only enable this mode when alias ownership is verified. A bad mapping merges
memory and continuity across users.

## API Behavior

- `/api/chat` generates a unique canonical web session id when the caller omits
  `sessionId`
- `/api/command` and `/api/history` require an explicit `sessionId`
- malformed canonical `sessionId` values are rejected instead of silently
  treated as legacy ids

This avoids shared default DM sessions for anonymous web clients.

## Transport Ingress

Session isolation only stays predictable when ingress paths emit canonical keys.
Current transport/session builders generate canonical keys for web, Discord,
email, Teams, WhatsApp, TUI, heartbeat, and scheduler flows. Legacy lookup is
still present for pre-migration rows and older caller inputs, but new runtime
paths should build canonical keys directly at ingress.
