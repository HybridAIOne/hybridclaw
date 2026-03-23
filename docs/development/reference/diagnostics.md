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
hybridclaw doctor providers
```

`doctor` checks runtime, gateway, config, credentials, database, providers,
local backends, Docker, channels, skills, security, and disk state.

## Request Logging

When environment-level checks pass but a specific turn still needs debugging,
start or restart the gateway with request logging enabled:

```bash
hybridclaw gateway start --log-requests
hybridclaw gateway restart --log-requests
```

That persists best-effort redacted prompts, responses, and tool payloads to
SQLite `request_log`. Treat it as sensitive operator data.
