---
name: apple-passwords
description: Open macOS Passwords or Keychain entries, locate saved logins, and read specific credentials safely.
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - apple
      - passwords
      - keychain
      - macos
    related_skills:
      - 1password
---

# Apple Passwords

Use this skill for Passwords.app and Keychain-backed secret workflows on macOS.

## Scope

- open or navigate the Passwords app
- locate the right login or passkey entry
- inspect Keychain metadata from the terminal
- read one specific keychain secret when the user explicitly asks for it

## Default Strategy

1. Confirm the exact site, service, or account first.
2. Prefer metadata lookup before secret readout.
3. Use the Passwords app for browsing and editing saved credentials.
4. Use the built-in `security` CLI only when terminal access is the simpler path.

## Passwords App

Open the app on macOS with:

```bash
open -a Passwords
```

Use the app when the user wants to browse, edit, share, or visually confirm a
saved login or passkey.

## Keychain CLI

For generic passwords, inspect metadata first:

```bash
security find-generic-password -s "example.com"
```

For internet-password style entries:

```bash
security find-internet-password -s example.com
```

Read the secret value only if the user explicitly asked for the password itself:

```bash
security find-generic-password -s "example.com" -a "alice@example.com" -w
security find-internet-password -s example.com -a "alice@example.com" -w
```

## Working Rules

- Do not print a password value unless the user explicitly wants it.
- Confirm the service and account before running a secret read command.
- Prefer the GUI app when multiple matches exist or the user is unsure which
  credential is correct.
- Treat Keychain output as sensitive and avoid pasting it back into chat unless
  the user insists.
- If the user only needs to verify that an entry exists, stop at metadata.

## Important Limitation

Passwords.app does not expose a stable dedicated CLI. In practice, use the GUI
for browsing and editing, and the built-in Keychain CLI for direct terminal
lookups where that is appropriate.

## Pitfalls

- Do not assume every Passwords.app item is easy to resolve from one terminal
  query.
- Do not dump all matching secrets when only one item is needed.
- Do not store retrieved passwords in tracked files or long-lived plain-text
  notes.
