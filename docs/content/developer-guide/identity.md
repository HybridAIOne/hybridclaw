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

- `hybridai`: canonical HybridAI-hosted user authority and the default used by
  `formatUserId(username)`
- `local`: un-federated single-instance authority for local-only operators or
  demos

Other authorities are valid when a federated identity provider or deployment
owns that namespace.

## Helpers

Use `parseUserId()` and `formatUserId()` from `src/identity/user-id.ts` at
boundaries instead of hand-parsing strings. Use `userIdsEqual()` or
`compareUserIds()` when comparing IDs so case and whitespace are normalized
before comparison.
