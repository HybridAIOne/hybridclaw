---
name: 1password
description: Install and use 1Password CLI (`op`) to sign in, inspect vault items, read secrets safely, and inject secrets into commands.
user-invocable: true
metadata:
  hybridclaw:
    category: security
    short_description: "1Password CLI access."
    tags:
      - secrets
      - enterprise
      - 1password
    install:
      - id: brew
        kind: brew
        formula: 1password-cli
        bins: ["op"]
        label: Install 1Password CLI (brew)
---
# 1Password CLI

Use this skill for host-side secret workflows with 1Password CLI.

## Default Workflow

1. Check whether `op` is installed:
   ```bash
   op --version
   ```
2. If it is missing, tell the user to run:
   ```bash
   hybridclaw skill install 1password brew
   ```
   or install it manually.
3. Verify sign-in state:
   ```bash
   op whoami
   op vault list
   ```
4. Confirm the exact vault and item before reading any secret.
5. Prefer secret injection over copying values into files or chat.

## Safe Read Patterns

List items:

```bash
op item list --vault "Engineering"
```

Inspect an item without dumping every field:

```bash
op item get "Prod API" --vault "Engineering"
```

Read one field only:

```bash
op item get "Prod API" --vault "Engineering" --fields label=password
```

Read by secret reference:

```bash
op read "op://Engineering/Prod API/password"
```

## Safe Injection Patterns

Run a command with secrets injected:

```bash
op run --env-file=.env.1password -- your-command
```

Inject a template into a throwaway runtime file:

```bash
RUNTIME_ENV="$(mktemp /tmp/runtime.env.XXXXXX)"
chmod 600 "$RUNTIME_ENV"
trap 'rm -f "$RUNTIME_ENV"' EXIT INT TERM
op inject -i .env.template -o "$RUNTIME_ENV"
```

Prefer `/tmp` or an untracked runtime path. Do not inject into tracked files unless the user explicitly asks. If you are done before the shell exits, run `rm -f "$RUNTIME_ENV"` and `trap - EXIT INT TERM`.

## Rules

- Never paste a secret value into chat unless the user explicitly requests it and there is no safer option.
- Never commit, log, or echo secrets into shell history on purpose.
- Default to read-only operations. Creating or editing vault items needs explicit user confirmation.
- If `op whoami` fails, stop and tell the user they need to unlock the desktop app or sign in again.
- If the task only needs a secret for one command, use `op run` instead of reading the secret into plain text.
