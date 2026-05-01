---
title: Local vs Cloud Setup
description: Choose a local, tunneled, or cloud HybridClaw deployment and switch between them safely.
sidebar_position: 5
---

# Local vs Cloud Setup

HybridClaw can run entirely on one machine, on a local machine with a public
tunnel, or on a cloud host. Pick the smallest exposure model that satisfies the
channels and operators you need.

## Decision Tree

Start with one question: does anything outside your machine need to call the
gateway?

```text
No
  -> Use local-only.

Yes, but only your own browser, CLI, or TUI needs remote access
  -> Use local with SSH or Tailscale Serve.

Yes, a vendor webhook, phone provider, relay, or peer instance needs a public URL
  -> Use local with a public tunnel for development.
  -> Use cloud or a stable reverse proxy for production.
```

Choose a public URL when you use:

- Microsoft Teams, because Azure Bot Framework delivers inbound messages by HTTPS webhook
- Twilio Voice, because Twilio needs both an HTTPS webhook and a WSS relay URL
- remote BlueBubbles iMessage relay webhooks
- plugin inbound webhooks or external callbacks that target this gateway
- hierarchical swarm or cross-instance delegation where another HybridClaw instance must reach this gateway over HTTP
- an operator workflow where teammates open `/chat`, `/agents`, or `/admin` from outside the gateway host

You usually do not need a public URL for:

- local TUI sessions on the same host
- the built-in browser surfaces opened at `http://127.0.0.1:9090`
- Discord, Slack Socket Mode, Telegram polling, Signal, WhatsApp linked-device sessions, or email polling when the gateway initiates the outbound connection
- local subagent delegation inside one gateway process
- local-only model backends such as Ollama, LM Studio, llama.cpp, or vLLM

## Choose A Mode

| Mode | Use when | Public URL | Operational shape |
| --- | --- | --- | --- |
| Local-only | You are testing, using the TUI, or keeping all access on one workstation | No | Gateway binds to loopback, browser and TUI run on the same host |
| Local with private remote access | You want your own devices to reach the gateway | No public internet URL | Gateway stays on loopback behind SSH or Tailscale Serve |
| Local with public tunnel | You need webhook testing from a vendor or peer instance | Yes | Gateway stays on loopback, ngrok/Tailscale Funnel/Cloudflare Tunnel exposes HTTPS |
| Cloud | You need a stable URL, always-on runtime, or multiple operators | Yes | Gateway runs on a server behind HTTPS, reverse proxy, and token auth |

## Configure Local-Only

Local-only is the default. Keep the gateway bound to loopback and point local
clients at the same origin:

```bash
hybridclaw config set deployment.mode local
hybridclaw config set deployment.tunnel.provider manual
hybridclaw config set ops.healthHost 127.0.0.1
hybridclaw config set ops.healthPort 9090
hybridclaw config set ops.gatewayBaseUrl http://127.0.0.1:9090
```

Start the gateway and use the local surfaces:

```bash
hybridclaw gateway
hybridclaw tui
```

Open:

- `http://127.0.0.1:9090/chat`
- `http://127.0.0.1:9090/agents`
- `http://127.0.0.1:9090/admin`

If the gateway is only reachable from localhost and `WEB_API_TOKEN` is unset,
the browser surfaces open without a login prompt. Add `ops.webApiToken` before
exposing the gateway beyond loopback.

## Configure Local With Remote Access

Use this mode when you want your own devices to reach a workstation or homelab
host without publishing the gateway to the open internet.

On the gateway host:

```bash
hybridclaw config set deployment.mode local
hybridclaw config set deployment.tunnel.provider ssh
hybridclaw config set ops.healthHost 127.0.0.1
hybridclaw config set ops.healthPort 9090
hybridclaw config set ops.webApiToken "replace-with-a-long-random-token"
hybridclaw gateway
```

From the client machine:

```bash
ssh -N -L 19090:127.0.0.1:9090 user@gateway-host
hybridclaw config set ops.gatewayBaseUrl http://127.0.0.1:19090
hybridclaw config set ops.gatewayApiToken "replace-with-the-remote-token"
```

For Tailscale Serve, keep the same gateway settings and proxy
`localhost:9090` through Tailscale. See [Remote Access](../guides/remote-access.md)
for SSH, Tailscale Serve, and persistent macOS LaunchAgent examples.

## Configure Local With A Public Tunnel

Use a public tunnel for webhook development or a short-lived public URL. Keep
HybridClaw on loopback and let the tunnel own public HTTPS.

For managed ngrok:

```bash
hybridclaw config set deployment.mode local
hybridclaw config set deployment.tunnel.provider ngrok
hybridclaw config set deployment.tunnel.health_check_interval_ms 30000
hybridclaw config set ops.healthHost 127.0.0.1
hybridclaw config set ops.healthPort 9090
hybridclaw config set ops.webApiToken "replace-with-a-long-random-token"
hybridclaw secret set NGROK_AUTHTOKEN "replace-with-your-ngrok-token"
hybridclaw gateway
```

For managed Tailscale Funnel:

```bash
hybridclaw config set deployment.mode local
hybridclaw config set deployment.tunnel.provider tailscale
hybridclaw config set deployment.tunnel.health_check_interval_ms 30000
hybridclaw config set ops.webApiToken "replace-with-a-long-random-token"
hybridclaw secret set TS_AUTHKEY "replace-with-your-tailscale-authkey"
hybridclaw gateway
```

If you run a tunnel manually, set the public base URL after the tunnel starts:

```bash
hybridclaw config set deployment.mode local
hybridclaw config set deployment.tunnel.provider manual
hybridclaw config set deployment.public_url https://abc123.ngrok.app
hybridclaw config set ops.gatewayBaseUrl https://abc123.ngrok.app
```

Use `ops.gatewayBaseUrl` for generated callback URLs such as Twilio Voice. Use
`deployment.public_url` to record the operator-facing public origin and make
gateway/tunnel status easier to audit.

## Configure Cloud

Use cloud mode when the gateway needs a stable public hostname, an always-on
runtime, shared operator access, or production webhooks.

On the cloud host, keep HybridClaw behind HTTPS and token auth:

```bash
hybridclaw config set deployment.mode cloud
hybridclaw config set deployment.public_url https://hybridclaw.example.com
hybridclaw config set ops.gatewayBaseUrl https://hybridclaw.example.com
hybridclaw config set ops.webApiToken "replace-with-a-long-random-token"
hybridclaw config set ops.gatewayApiToken "replace-with-a-long-random-token"
```

Prefer this topology:

```text
Internet HTTPS
  -> reverse proxy or platform router
  -> 127.0.0.1:9090 on the gateway host
  -> HybridClaw gateway
```

If your platform requires the Node process to bind a non-loopback interface,
put the host behind the platform's HTTPS router or firewall and keep
`ops.webApiToken` set. Do not publish an unauthenticated `/chat`, `/agents`, or
`/admin` surface.

For server packages and host-managed tunnels, see
[Installation](./installation.md), [Remote Access](../guides/remote-access.md),
and [Tailscale Funnel](../guides/tailscale-funnel.md).

## Switch Between Modes

Switching changes runtime config and client defaults. Restart or reload the
gateway after changing deployment settings.

From local-only to public tunnel:

```bash
hybridclaw config set deployment.mode local
hybridclaw config set deployment.tunnel.provider ngrok
hybridclaw secret set NGROK_AUTHTOKEN "replace-with-your-ngrok-token"
hybridclaw config set ops.webApiToken "replace-with-a-long-random-token"
hybridclaw gateway restart --foreground
```

From public tunnel to cloud:

```bash
hybridclaw config set deployment.mode cloud
hybridclaw config set deployment.public_url https://hybridclaw.example.com
hybridclaw config set ops.gatewayBaseUrl https://hybridclaw.example.com
hybridclaw config set deployment.tunnel.provider manual
hybridclaw gateway restart --foreground
```

From cloud back to local-only on a workstation:

```bash
hybridclaw config set deployment.mode local
hybridclaw config set deployment.tunnel.provider manual
hybridclaw config set deployment.public_url ""
hybridclaw config set ops.healthHost 127.0.0.1
hybridclaw config set ops.healthPort 9090
hybridclaw config set ops.gatewayBaseUrl http://127.0.0.1:9090
hybridclaw gateway restart --foreground
```

When switching a client machine from one gateway to another, update only the
client pointer:

```bash
hybridclaw config set ops.gatewayBaseUrl https://hybridclaw.example.com
hybridclaw config set ops.gatewayApiToken "replace-with-that-gateway-token"
```

## Verify The Active Setup

Use these checks after each switch:

```bash
hybridclaw gateway status
hybridclaw doctor
```

In the browser, `/admin/gateway` shows the configured public URL and managed
tunnel status. For channel-specific verification, follow
[Connect Your First Channel](./first-channel.md) and the transport guide for
the channel you are enabling.

Security baseline:

- keep the gateway on loopback unless a trusted proxy or platform requires a different bind address
- require `ops.webApiToken` before any non-local browser access
- keep webhook tokens and tunnel tokens in the encrypted secret store
- update vendor webhook URLs whenever the public hostname changes
- prefer stable cloud or reverse-proxy hostnames over free tunnel URLs for production channels
