---
title: Remote Access
description: Reach HybridClaw from another machine with SSH tunnels or host-managed Tailscale while keeping the gateway bound to loopback.
sidebar_position: 7
---

# Remote Access

HybridClaw's gateway is a single HTTP service. Once another machine can reach
that service, the same remote endpoint can power:

- the web chat at `/chat`
- the agent dashboard at `/agents`
- the admin console at `/admin`
- `hybridclaw tui`
- client-side gateway calls such as `hybridclaw gateway status`

The safest default is still the same as local operation:

- keep `ops.healthHost` on `127.0.0.1`
- keep the gateway on its default port `9090` unless you have a reason to move
  it
- require a bearer token with `ops.webApiToken`
- expose the loopback service with SSH or a host-managed Tailscale proxy instead
  of binding the gateway directly to the public internet

HybridClaw does not automate Tailscale Serve/Funnel or manage SSH tunnels for
you. Those parts are configured at the host or client OS layer.

## Recommended Baseline

On the machine that runs the gateway, keep the HTTP server loopback-only and
turn on token auth:

```bash
hybridclaw config set ops.healthHost 127.0.0.1
hybridclaw config set ops.healthPort 9090
hybridclaw config set ops.webApiToken "replace-with-a-long-random-token"
```

`ops.webApiToken` gates `/chat`, `/agents`, and `/admin`.
`ops.gatewayApiToken` is optional. If you leave it unset, client-side gateway
calls fall back to the same token automatically. Set a separate
`ops.gatewayApiToken` only when you want the CLI or TUI to use a different
bearer token than the browser surfaces.

If you prefer env-backed or store-backed secrets for long-lived setups, use the
SecretRef support described in [Configuration](../reference/configuration.md)
instead of storing plaintext tokens in `config.json`.

## SSH Tunnel

SSH is the universal fallback. It keeps the gateway loopback-only on the remote
host and forwards a local port on the client machine.

From the client machine:

```bash
ssh -N -L 19090:127.0.0.1:9090 user@gateway-host
```

With the tunnel open:

- browser access uses `http://127.0.0.1:19090/chat`
- the dashboard uses `http://127.0.0.1:19090/agents`
- the admin console uses `http://127.0.0.1:19090/admin`

Using `19090` on the client side avoids colliding with a local HybridClaw
instance that might already be using `9090`.

### Remote CLI And TUI Defaults

If you want the local CLI or TUI to talk to the tunneled gateway by default,
configure the client machine like this:

```bash
hybridclaw config set ops.gatewayBaseUrl http://127.0.0.1:19090
hybridclaw config set ops.gatewayApiToken "replace-with-the-remote-token"
```

After that, `hybridclaw tui`, `hybridclaw gateway status`, and other
client-side gateway calls use the forwarded remote gateway instead of a local
one.

## Tailscale

Tailscale works well when the gateway host is already on your tailnet. The
recommended pattern is still to keep HybridClaw itself bound to loopback and
let Tailscale proxy to `http://127.0.0.1:9090`.

Tailnet-only access with Serve:

```bash
tailscale serve --bg localhost:9090
```

Public HTTPS access with Funnel:

```bash
sudo tailscale funnel --bg localhost:9090
```

In both cases:

- HybridClaw still relies on `ops.webApiToken` and `ops.gatewayApiToken` for
  browser and API auth
- Tailscale handles transport security and routing, not HybridClaw-specific
  identity auth
- clients can point `ops.gatewayBaseUrl` at the served HTTPS origin

Example client config for a tailnet URL:

```bash
hybridclaw config set ops.gatewayBaseUrl https://gateway-host.tailnet.ts.net
hybridclaw config set ops.gatewayApiToken "replace-with-the-remote-token"
```

## Deployment Config And ngrok

Runtime config can record the intended exposure mode and tunnel provider:

```bash
hybridclaw config set deployment.mode local
hybridclaw config set deployment.tunnel.provider ngrok
hybridclaw config set deployment.tunnel.health_check_interval_ms 30000
hybridclaw secret set NGROK_AUTHTOKEN "replace-with-your-ngrok-token"
```

The deployment keys make local, cloud, and tunnel-backed setups explicit in
operator state. Manual SSH and Tailscale setups can use `manual`, `ssh`, or
`tailscale` as the provider value. The built-in ngrok provider reads
`NGROK_AUTHTOKEN` from encrypted runtime secrets when it is used by a gateway
deployment flow, checks active tunnels every 30 seconds by default, and
reconnects failed tunnels with capped backoff.

## macOS: Persistent SSH Tunnel Via LaunchAgent

If your client machine is a Mac, you can make the SSH tunnel persistent across
reboots and crashes with an SSH host entry plus a LaunchAgent.

### Step 1: Add SSH Config

Edit `~/.ssh/config`:

```ssh
Host remote-hybridclaw
    HostName <REMOTE_IP_OR_DNS>
    User <REMOTE_USER>
    LocalForward 19090 127.0.0.1:9090
    IdentityFile ~/.ssh/id_ed25519
```

Replace `<REMOTE_IP_OR_DNS>` and `<REMOTE_USER>` with your values.

### Step 2: Copy Your SSH Key

```bash
ssh-copy-id -i ~/.ssh/id_ed25519 <REMOTE_USER>@<REMOTE_IP_OR_DNS>
```

### Step 3: Point The Local Client At The Tunnel

Run this on the Mac client:

```bash
hybridclaw config set ops.gatewayBaseUrl http://127.0.0.1:19090
hybridclaw config set ops.gatewayApiToken "replace-with-the-remote-token"
```

### Step 4: Create The LaunchAgent

Save this as
`~/Library/LaunchAgents/one.hybridai.hybridclaw.ssh-tunnel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>one.hybridai.hybridclaw.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-hybridclaw</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### Step 5: Load The LaunchAgent

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/one.hybridai.hybridclaw.ssh-tunnel.plist
```

Useful follow-up commands:

```bash
launchctl kickstart -k gui/$UID/one.hybridai.hybridclaw.ssh-tunnel
launchctl bootout gui/$UID/one.hybridai.hybridclaw.ssh-tunnel
```

With the LaunchAgent loaded, the tunnel stays available at
`http://127.0.0.1:19090`, so the local browser, TUI, and gateway client calls
keep working after login or transient disconnects.

## Security Notes

- Prefer loopback plus SSH or Tailscale over binding the gateway directly to
  `0.0.0.0`.
- Treat `ops.webApiToken` and `ops.gatewayApiToken` as operator secrets.
- If you expose the gateway through Tailscale Funnel or another public reverse
  proxy, require a strong token and prefer HTTPS end to end.
- `ops.gatewayBaseUrl` is a client-side pointer. Changing it does not harden
  the remote host by itself.
- `/docs` and `/health` are useful for diagnostics, but they are not a
  substitute for gating the interactive surfaces with a token.
