---
title: Diagnostics
description: Diagnose runtime issues, apply safe fixes, and capture turn-level request logs.
sidebar_position: 4
---

# Diagnostics

Use `hybridclaw doctor` when setup, auth, Docker, or runtime state looks
wrong.

```bash
hybridclaw doctor
hybridclaw doctor --fix
hybridclaw doctor --json
hybridclaw doctor docker
hybridclaw doctor browser-use
hybridclaw doctor providers
```

`doctor` checks runtime, gateway, config, credentials, database, providers,
local backends, browser automation, Docker, channels, skills, security, and
disk state in parallel.

Useful flags:

- `hybridclaw doctor --fix` applies safe remediations where a check exposes
  one, then reruns the fixable checks
- `hybridclaw doctor --json` prints a machine-readable report for CI or
  automation while still returning exit code `1` if errors remain
- `hybridclaw doctor <category>` narrows the report to one subsystem, for
  example `docker`, `browser-use`, or `providers`

When the config checks flag built-in tools that have gone unused for a while,
use `hybridclaw tool list`, `hybridclaw tool disable <name>`, and
`hybridclaw tool enable <name>` to keep the prompt surface tighter. The doctor
report treats the `browser_*` subtools as one browser toolset, so it only
suggests disabling them when that whole toolset is unused.

The `browser-use` category verifies the Playwright Chromium install used by
local browser automation. With `--fix`, HybridClaw offers the lazy Chromium
install remediation when the browser runtime is missing.

## Resource Hygiene

`doctor` includes a resource hygiene maintenance pass that detects stale
gateway artifacts such as orphaned sessions, leaked worker pool slots, and
abandoned workspace state. The check caches a DB snapshot and disk-state diff
so repeated runs are efficient. When `--fix` is passed, safe cleanups are
applied automatically (e.g. reclaiming leaked pool slots and removing empty
sessions).

## Request Logging

When environment-level checks pass but a specific turn still needs debugging,
start or restart the gateway with request logging enabled:

```bash
hybridclaw gateway start --log-requests
hybridclaw gateway restart --log-requests
```

That persists best-effort redacted prompts, responses, and tool payloads to
SQLite `request_log` for turn-level debugging. Treat it as sensitive operator
data.

For lower-level provider debugging on a local machine, use:

```bash
hybridclaw gateway start --debug-model-responses
hybridclaw gateway restart --debug-model-responses
```

This writes provider response diagnostics and the last prompt under the
HybridClaw data directory. Treat those files as highly sensitive, because they
can include model payloads that normal operator logs intentionally avoid.
