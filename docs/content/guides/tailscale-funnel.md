---
title: Tailscale Funnel
description: Expose a local HybridClaw gateway through Tailscale Funnel with host login or TS_AUTHKEY.
sidebar_position: 8
---

# Tailscale Funnel

Tailscale Funnel exposes a local gateway over a public `*.ts.net` HTTPS URL.
HybridClaw keeps the gateway process bound to the local host and manages the
Funnel binding through the `tailscale` CLI.

## Prerequisites

- Tailscale installed on the gateway host
- `tailscaled` running
- Funnel enabled for the tailnet
- A Funnel grant that permits the gateway node to publish HTTPS on port `443`
- HybridClaw gateway auth enabled with `ops.webApiToken`

Install Tailscale from the package for your host OS. On macOS, use the App Store
or standalone system extension package when you need Funnel for local web
services. On Linux, install and start the daemon:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled
```

## Tailnet Policy Grant

Funnel must be allowed by tailnet policy. Add a grant similar to this in the
Tailscale admin console, scoped to the users or tags that should operate the
gateway:

```json
{
  "grants": [
    {
      "src": ["autogroup:member"],
      "dst": ["tag:hybridclaw"],
      "ip": ["443"]
    }
  ],
  "nodeAttrs": [
    {
      "target": ["tag:hybridclaw"],
      "attr": ["funnel"]
    }
  ]
}
```

Use narrower `src` and `dst` selectors for production tailnets. The important
parts are the HTTPS port and the `funnel` node attribute.

## Authenticate Tailscale

For an interactive host login:

```bash
sudo tailscale login
```

For unattended hosts, create an auth key in the Tailscale admin console and
store it in HybridClaw's encrypted runtime secret store:

```bash
hybridclaw secret set TS_AUTHKEY "tskey-auth-..."
```

When `TS_AUTHKEY` is present and the local daemon is logged out, HybridClaw runs
`tailscale up --auth-key <authkey>` before starting Funnel. Error messages and
audit entries redact the auth key.

## Configure HybridClaw

Keep the gateway loopback-only and require a bearer token:

```bash
hybridclaw config set ops.healthHost 127.0.0.1
hybridclaw config set ops.healthPort 9090
hybridclaw config set ops.webApiToken "replace-with-a-long-random-token"
```

Set local deployment mode and choose the Tailscale tunnel provider:

```bash
hybridclaw config set deployment.mode local
hybridclaw config set deployment.tunnel.provider tailscale
hybridclaw config set deployment.tunnel.health_check_interval_ms 30000
```

Start the gateway normally:

```bash
hybridclaw gateway
```

HybridClaw invokes:

```bash
tailscale funnel --bg localhost:9090
```

The resulting public URL is reported through the admin tunnel status API as
`public_url`.

## Verify And Stop

Inspect the active Funnel binding:

```bash
tailscale funnel status
tailscale funnel status --json
```

Point remote clients at the public HTTPS origin and use the configured gateway
API token:

```bash
hybridclaw config set ops.gatewayBaseUrl https://gateway-host.tailnet.ts.net
hybridclaw config set ops.gatewayApiToken "replace-with-the-remote-token"
```

To stop Funnel outside HybridClaw:

```bash
tailscale funnel --bg off
```

HybridClaw uses the same stop command for best-effort cleanup. Tailscale treats
that command as host-level Funnel cleanup, so it can also disable other Funnel
bindings managed outside HybridClaw on the same machine.

## Security Notes

- Keep HybridClaw bound to loopback and let Tailscale own public transport.
- Treat `TS_AUTHKEY`, `ops.webApiToken`, and `ops.gatewayApiToken` as operator
  secrets.
- Use reusable, pre-authorized, and ephemeral auth keys where possible for
  automation.
- Funnel makes the selected service publicly reachable. Token-gate the
  interactive HybridClaw surfaces before enabling it.
