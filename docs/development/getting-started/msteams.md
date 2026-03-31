---
title: Microsoft Teams Setup
description: Teams-specific setup flow, credentials, and webhook handoff.
sidebar_position: 5
---

# Microsoft Teams Setup

The full Teams setup guide lives at [docs/msteams.md](../../msteams.md).

That flow covers:

- Azure app registration and bot credentials
- Azure Bot webhook and Teams channel configuration
- `hybridclaw auth login msteams`
- local tunnel setup
- DM and channel smoke tests

If you only need the HybridClaw side of the setup, the key command is:

```bash
hybridclaw auth login msteams \
  --app-id <app-id> \
  --tenant-id <tenant-id> \
  --app-password <secret>
```

After that, start the gateway normally. When `msteams.enabled` is true and
`MSTEAMS_APP_PASSWORD` is configured, the Teams channel starts inside the
gateway automatically.
