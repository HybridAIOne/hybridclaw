---
title: Cloudflare Tunnel
description: Expose a local HybridClaw gateway through Cloudflare Tunnel with cloudflared.
sidebar_position: 9
---

# Cloudflare Tunnel

Cloudflare Tunnel exposes a local gateway through Cloudflare's edge without
opening inbound firewall ports. HybridClaw keeps the gateway bound to loopback
and manages a `cloudflared tunnel run` process for the configured tunnel.

## Prerequisites

- A Cloudflare account with a domain on Cloudflare DNS
- `cloudflared` installed on the gateway host
- A Cloudflare Tunnel with a public hostname route pointing at the gateway
- HybridClaw gateway auth enabled with `ops.webApiToken`

Install `cloudflared` from Cloudflare's package for your host OS. On macOS:

```bash
brew install cloudflare/cloudflare/cloudflared
```

On Linux, use Cloudflare's package repository for your distribution, then verify
the binary is available:

```bash
cloudflared --version
```

## Create The Tunnel

The simplest managed setup is a remotely managed tunnel token from the
Cloudflare dashboard:

1. Go to Cloudflare Zero Trust.
2. Open **Networks** > **Tunnels**.
3. Create or select a Cloudflare Tunnel.
4. Add a published application route.
5. Set the public hostname, for example `hybridclaw.example.com`.
6. Set the service URL to the local gateway, for example
   `http://localhost:9090`.
7. Copy the tunnel token from the connector install command.

Store the token in HybridClaw's encrypted runtime secret store:

```bash
hybridclaw secret set CLOUDFLARE_TUNNEL_TOKEN "replace-with-your-tunnel-token"
```

HybridClaw passes this token to `cloudflared` through the `TUNNEL_TOKEN`
environment variable, so the token is not placed in the child process argument
list.

## Locally Managed Credentials

For locally managed tunnels, store the origin certificate and tunnel
credentials JSON instead:

```bash
hybridclaw secret set CLOUDFLARE_CERT_PEM "$(cat ~/.cloudflared/cert.pem)"
hybridclaw secret set CLOUDFLARE_TUNNEL_JSON "$(cat ~/.cloudflared/<TUNNEL_ID>.json)"
```

The credentials JSON must include the tunnel `TunnelID`. HybridClaw writes both
secrets to temporary `0600` files, generates a temporary `cloudflared` config
with the configured hostname and local service URL, starts
`cloudflared tunnel --config <path> run <TunnelID>`, and removes the temporary
files when the provider stops.

## Configure HybridClaw

Keep the gateway loopback-only and require a bearer token:

```bash
hybridclaw config set ops.healthHost 127.0.0.1
hybridclaw config set ops.healthPort 9090
hybridclaw config set ops.webApiToken "replace-with-a-long-random-token"
```

Set local deployment mode, the Cloudflare provider, and the public hostname:

```bash
hybridclaw config set deployment.mode local
hybridclaw config set deployment.tunnel.provider cloudflare
hybridclaw config set deployment.public_url https://hybridclaw.example.com
```

Start the gateway normally:

```bash
hybridclaw gateway
```

HybridClaw invokes:

```bash
cloudflared tunnel run
```

for token-backed remotely managed tunnels, or:

```bash
cloudflared tunnel --config <temporary-config> run <TunnelID>
```

for locally managed tunnel credentials. The configured `deployment.public_url`
is reported through the admin tunnel status API as `public_url`.

## Verify And Stop

Check the tunnel route from another network:

```bash
curl -fsS https://hybridclaw.example.com/health
```

Point remote clients at the public HTTPS origin and use the configured gateway
API token:

```bash
hybridclaw config set ops.gatewayBaseUrl https://hybridclaw.example.com
hybridclaw config set ops.gatewayApiToken "replace-with-the-remote-token"
```

HybridClaw stops the managed `cloudflared` process when the gateway shuts down,
when the provider configuration changes, or when an operator triggers a manual
tunnel reconnect.

## Security Notes

- Keep HybridClaw bound to loopback and let Cloudflare own public transport.
- Treat `CLOUDFLARE_TUNNEL_TOKEN`, `CLOUDFLARE_CERT_PEM`,
  `CLOUDFLARE_TUNNEL_JSON`, `ops.webApiToken`, and `ops.gatewayApiToken` as
  operator secrets.
- Scope Cloudflare API tokens and tunnel credentials to the minimum account and
  tunnel needed by this gateway.
- Cloudflare Tunnel makes the selected service publicly reachable. Token-gate
  the interactive HybridClaw surfaces before enabling it.
