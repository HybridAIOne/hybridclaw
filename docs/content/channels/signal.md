---
title: Signal
description: Link Signal as a companion device with signal-cli, connect HybridClaw to the daemon, configure DM and group policies, and verify delivery.
sidebar_position: 8
---

# Signal

Signal connects HybridClaw to a local or network-reachable `signal-cli`
compatible daemon. The recommended setup is to link `signal-cli` as a companion
device from the Signal mobile app, then point HybridClaw at the daemon. Start
with one allowlisted DM, then widen access only after one full inbound and
outbound exchange works.

For shared config and rollout patterns, also see
[Local Config And Secrets](./local-config-and-secrets.md) and
[Policies And Allowlists](./policies-and-allowlists.md).

## Step 1: Prepare signal-cli

HybridClaw Cloud gateway images include `signal-cli` on amd64 hosts, so the
admin QR setup can run without a shell. Local installs need one of these
runtime paths:

- install `signal-cli` on the host and keep `signal-cli` on `PATH`
- run a `signal-cli-rest-api` sidecar and persist its data directory

The current upstream native Linux release is x86_64. On arm64 hosts, use a
sidecar image or another host-provided `signal-cli` daemon.

## Step 2: Choose A Signal Account Setup Path

### Path A: QR Link Existing Signal App

If you already use Signal on your phone, link `signal-cli` as another device:

```bash
signal-cli link -n HybridClaw
```

`signal-cli` prints a QR code or a `sgnl://linkdevice...` link. On your phone,
open Signal, go to **Settings → Linked Devices → Link New Device**, and scan
the QR code.

You can also start this same linked-device flow from the admin UI:

1. Open `/admin/channels`.
2. Select **Signal**.
3. Click **Start QR link**.
4. Scan the QR code from Signal mobile under **Settings → Linked Devices**.

The admin UI enables **Start QR link** only when the gateway can run
`signal-cli --version`. If the probe fails, install `signal-cli` in the gateway
runtime or use a sidecar daemon and complete the link flow there.

This is the same model as WhatsApp linked-device setup: your phone remains the
primary Signal device, and the server gets its own linked session. Do not use
the SMS registration flow for your personal phone number unless you understand
that it can replace or disturb the existing primary Signal session.

For a Docker sidecar, start the sidecar first and run the link command inside
it so the linked-device state is written to the mounted `signal-cli` data
volume:

```bash
docker run --rm -it \
  -v "$HOME/.local/share/signal-cli:/home/.local/share/signal-cli" \
  bbernhard/signal-cli-rest-api:latest \
  signal-cli link -n HybridClaw
```

### Path B: Register A Dedicated Signal Number

Use this when you want HybridClaw to own a separate bot number.

1. Get a phone number that can receive SMS or voice verification.
2. Run registration:

```bash
signal-cli -a +14155550123 register
```

If Signal asks for a captcha:

1. Open `https://signalcaptchas.org/registration/generate.html`.
2. Complete the captcha and copy the `signalcaptcha://...` link target.
3. Run registration again from the same network when possible:

```bash
signal-cli -a +14155550123 register --captcha 'signalcaptcha://...'
```

Verify with the SMS or voice code:

```bash
signal-cli -a +14155550123 verify 123456
```

Registering a number with `signal-cli` can replace the main Signal app session
for that number. Prefer Path A for an existing personal account, or use Path B
with a dedicated bot number.

## Step 3: Start A signal-cli Compatible Daemon

HybridClaw does not talk to the Signal network directly. It expects the linked
`signal-cli` runtime to expose:

- `GET /api/v1/events?account=<account>` for inbound Server-Sent Events
- `POST /api/v1/rpc` for JSON-RPC methods such as `send` and `sendTyping`

Keep the daemon bound to localhost or a trusted private network unless you have
put your own network controls in front of it.

Use the daemon account value exactly as the daemon reports it, usually an
E.164 phone number such as `+14155550123`.

With the native `signal-cli` daemon:

```bash
signal-cli --account +14155550123 daemon --http 127.0.0.1:8080
```

With the Docker REST API sidecar:

```bash
docker run -d --name hybridclaw-signal \
  -p 127.0.0.1:8080:8080 \
  -v "$HOME/.local/share/signal-cli:/home/.local/share/signal-cli" \
  -e MODE=json-rpc \
  bbernhard/signal-cli-rest-api:latest
```

## Step 4: Save Signal Config

For a private allowlisted DM setup:

```bash
hybridclaw channels signal setup \
  --daemon-url http://127.0.0.1:8080 \
  --account +14155550123 \
  --allow-from +14155551212 \
  --group-policy disabled
```

If you want to test with any DM sender while groups stay disabled:

```bash
hybridclaw channels signal setup \
  --daemon-url http://127.0.0.1:8080 \
  --account +14155550123 \
  --dm-policy open \
  --group-policy disabled
```

Optional tuning:

```bash
hybridclaw channels signal setup \
  --account +14155550123 \
  --text-chunk-limit 4000 \
  --reconnect-interval-ms 5000
```

Notes:

- `signal.daemonUrl` defaults to `http://127.0.0.1:8080` in the example config
- `signal.account` is the Signal account owned by the daemon
- `signal.allowFrom` accepts Signal phone numbers, Signal UUIDs, or `*`
- `signal.groupAllowFrom` defaults to `signal.allowFrom` when left empty
- groups stay disabled unless you set `signal.groupPolicy` to `allowlist` or
  `open`
- outbound `message` sends must use canonical Signal ids like
  `signal:+15551234567`, `signal:<uuid>`, or `signal:group:<groupId>`

## Step 5: Enable One Group, If Needed

Keep groups disabled for the first test. After DM delivery works, enable one
allowlisted group sender:

```bash
hybridclaw channels signal setup \
  --account +14155550123 \
  --group-policy allowlist \
  --group-allow-from +14155551212
```

Use `open` only when every sender in Signal group contexts should be allowed:

```bash
hybridclaw channels signal setup \
  --account +14155550123 \
  --group-policy open
```

## Step 6: Let The Gateway Reload, Or Restart It If Needed

```bash
hybridclaw gateway restart --foreground
hybridclaw gateway status
```

If the gateway is already running and you have the admin UI open, you can also
go to `/admin/gateway` and click `Reload Gateway`.

When config changes are picked up, the gateway restarts the Signal integration.
Look for log lines like:

```text
Config changed, restarting Signal integration
Signal integration started inside gateway
```

## Step 7: Verify The Setup

1. Send a Signal DM from an allowlisted phone number or UUID.
2. Confirm HybridClaw replies in the same Signal conversation.
3. Send a proactive message with a canonical target when you need an outbound
   test:

```text
Send "Signal test from HybridClaw" to signal:+14155551212
```

If the message does not arrive:

- confirm the daemon is reachable from the HybridClaw host at
  `signal.daemonUrl`
- confirm `signal.account` matches the daemon account
- confirm the sender matches `signal.allowFrom` or the policy is `open`
- keep `signal.groupPolicy` disabled until DM delivery works

## Remote Or Cloud Installs

HybridClaw can be remote, but Signal still needs a reachable `signal-cli`
runtime. On amd64 HybridClaw Cloud gateway images, `signal-cli` is bundled, so
the admin QR setup can run directly from `/admin/channels`. On other hosts,
link the device on the VM or in the sidecar container, then run the daemon
there and save the URL with `hybridclaw channels signal setup`.

If the hosting environment has no shell but has `signal-cli` installed in the
gateway runtime, use `/admin/channels` → **Signal** → **Start QR link**. The
gateway runs `signal-cli link -n HybridClaw` server-side and displays the QR
code in the browser.

If the host cannot run `signal-cli` at all, use one of these deployment shapes:

- run `signal-cli-rest-api` as a managed sidecar and link inside that sidecar's
  persisted data volume
- link `signal-cli` on a machine you control, persist its data directory, and
  mount that directory into the cloud runtime
- use a host that provides a short-lived setup shell, then disable shell access
  after the linked-device state is written
