---
title: A2A Peer Pairing
description: Connect two HybridClaw instances so agents can address each other from chat and receive replies in the same thread.
sidebar_position: 8
---

# A2A Peer Pairing

A2A lets one HybridClaw instance send an agent-to-agent message to another
trusted HybridClaw instance. After pairing, an operator can address a remote
agent from `/chat` and receive the remote reply in the same chat thread.

Canonical A2A agent IDs use this format:

```text
agent-slug@user-slug@instance-id
```

For example, `main@local@inst-i2` means:

- `main`: the agent slug on the peer instance
- `local`: the owner or user routing namespace
- `inst-i2`: the peer HybridClaw instance id

The leading `@` in chat is only mention syntax. To message that remote agent,
type:

```text
@main@local@inst-i2 Who are you?
```

## Before You Start

You need:

- two running HybridClaw gateways
- a stable base URL for each gateway that the other gateway can reach
- admin access to both gateways
- the peer's Agent Card endpoint reachable at `/.well-known/agent.json`

For same-machine testing, different loopback ports are enough, for example
`http://127.0.0.1:9191` and `http://127.0.0.1:9292`. For two machines, use
Tailscale, SSH forwarding, a private network, or another trusted HTTPS route.
See [Remote Access](./remote-access.md) for exposure patterns.

Set `deployment.public_url` on each instance before requesting peer
notification. HybridClaw uses that URL when it asks the peer to create the
reverse pairing request.

After pairing, `/admin/federation?tab=peers` can enable **A2A local mode**. This keeps
loopback and authenticated admin management available, leaves the Agent Card
and A2A delivery routes reachable, and disables other external gateway and
channel surfaces.

## A2A Encryption

HybridClaw pairing exchanges and pins two independent public keys per instance:

- an Ed25519 identity key for peer authentication and signed delegation tokens
- an X25519 key for end-to-end encryption of A2A message envelopes

Message envelopes are encrypted between the two gateway processes with compact
JWE (`ECDH-ES` plus `A256GCM`). A signed delegation token binds the encrypted
envelope digest to the authenticated sender. Once a peer's encryption key is
pinned, HybridClaw rejects plaintext messages from that peer and rejects an
Agent Card whose encryption fingerprint has changed.

HybridClaw pairings require an E2EE-capable peer. Manually trusted or
third-party A2A peers without this HybridClaw extension can use plaintext only
while **Require A2A E2EE** is disabled on
`/admin/federation?tab=peers`. Enable that switch
after pairing every HybridClaw peer to make the entire A2A boundary fail closed.

This is transport E2EE between HybridClaw instances. Messages are plaintext on
the endpoint hosts, after delivery into the local inbox, and when sent to a
configured model provider. The current static recipient keys do not provide
forward secrecy.

## Pair Two Instances In The Browser

1. Open the admin console for instance 1:

   ```text
   http://127.0.0.1:9191/admin
   ```

2. Open the admin console for instance 2:

   ```text
   http://127.0.0.1:9292/admin
   ```

3. On instance 1, open `/admin/federation?tab=peers`.

4. Enter instance 2's base URL or Agent Card URL:

   ```text
   http://127.0.0.1:9292
   ```

   or:

   ```text
   http://127.0.0.1:9292/.well-known/agent.json
   ```

5. Preview the pairing. Check the peer id, identity-key fingerprint, and
   encryption-key fingerprint before trusting it.

6. Start pairing with peer notification enabled. Instance 1 trusts instance 2,
   then sends a pairing request to instance 2.

7. On instance 2, open `/admin/federation?tab=peers` and approve the incoming request from
   instance 1. This reverse approval is what lets instance 2 send replies back
   to instance 1.

8. Confirm both trust pages show the other instance as `trusted`.

9. On instance 1, open `/chat` and send a message to the remote agent:

   ```text
   @main@local@inst-i2 Who are you?
   ```

10. The chat shows the A2A delivery status while the message is sent, then the
    reply from `main@local@inst-i2` appears in the same thread.

## Local Smoke Test With Curl

Use this when you want a deterministic two-instance test on one machine.

### 1. Prepare Two Runtime Homes

Use separate data directories and stable instance IDs. Reusing one data
directory for both instances will make trust and identity confusing.

```bash
export I1_DIR=/tmp/hc-i1
export I2_DIR=/tmp/hc-i2
export I1_URL=http://127.0.0.1:9191
export I2_URL=http://127.0.0.1:9292
export I1_TOKEN="$(openssl rand -base64 32)"
export I2_TOKEN="$(openssl rand -base64 32)"
```

### 2. Configure Ports, Public URLs, And Browser Tokens

```bash
HYBRIDCLAW_DATA_DIR="$I1_DIR" hybridclaw config set ops.healthPort 9191
HYBRIDCLAW_DATA_DIR="$I1_DIR" hybridclaw config set deployment.public_url "$I1_URL"
HYBRIDCLAW_DATA_DIR="$I1_DIR" hybridclaw secret set WEB_API_TOKEN "$I1_TOKEN"

HYBRIDCLAW_DATA_DIR="$I2_DIR" hybridclaw config set ops.healthPort 9292
HYBRIDCLAW_DATA_DIR="$I2_DIR" hybridclaw config set deployment.public_url "$I2_URL"
HYBRIDCLAW_DATA_DIR="$I2_DIR" hybridclaw secret set WEB_API_TOKEN "$I2_TOKEN"
```

### 3. Start Both Gateways

Use two terminals, or run one command and then the other when using managed
restart mode.

```bash
HYBRIDCLAW_DATA_DIR="$I1_DIR" HYBRIDCLAW_INSTANCE_ID=inst-i1 hybridclaw gateway restart --sandbox=host
HYBRIDCLAW_DATA_DIR="$I2_DIR" HYBRIDCLAW_INSTANCE_ID=inst-i2 hybridclaw gateway restart --sandbox=host
```

Check that each gateway reports the expected port and package root:

```bash
HYBRIDCLAW_DATA_DIR="$I1_DIR" hybridclaw gateway status
HYBRIDCLAW_DATA_DIR="$I2_DIR" hybridclaw gateway status
```

### 4. Pair Instance 1 To Instance 2

```bash
curl -sS -X POST "$I1_URL/api/admin/a2a/pairing" \
  -H "Authorization: Bearer $I1_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"peerUrl\":\"$I2_URL\",\"reason\":\"local A2A smoke test\",\"notifyPeer\":true}" \
  | jq
```

The response should include:

- `proposal.peerId` equal to `inst-i2`
- a trusted peer entry for `inst-i2`
- `remoteNotification.status` equal to `sent`

If `remoteNotification.status` is `failed` with `local public URL unavailable`,
set `deployment.public_url` on instance 1 and restart instance 1.

### 5. Approve Instance 1 On Instance 2

Instance 2 must trust instance 1 before it can send the reply back.

```bash
export I2_REQUEST_ID="$(
  curl -sS "$I2_URL/api/admin/a2a/trust" \
    -H "Authorization: Bearer $I2_TOKEN" \
    | jq -r '.pairingRequests[] | select(.peerId == "inst-i1" and .status == "pending") | .requestId' \
    | tail -n 1
)"

curl -sS -X POST "$I2_URL/api/admin/a2a/pairing/approve" \
  -H "Authorization: Bearer $I2_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"requestId\":\"$I2_REQUEST_ID\",\"reason\":\"local A2A smoke test\"}" \
  | jq
```

Confirm both sides trust each other:

```bash
curl -sS "$I1_URL/api/admin/a2a/trust" \
  -H "Authorization: Bearer $I1_TOKEN" \
  | jq '.peers[] | {peerId,status,agentCardUrl,deliveryUrl,e2ee}'

curl -sS "$I2_URL/api/admin/a2a/trust" \
  -H "Authorization: Bearer $I2_TOKEN" \
  | jq '.peers[] | {peerId,status,agentCardUrl,deliveryUrl,e2ee}'
```

Each peer should report `e2ee.required: true` and the expected encryption-key
fingerprint. You can then enable **Require A2A E2EE** on both trust pages.

### 6. Send A Chat Message Across Instances

Open instance 1's chat:

```text
http://127.0.0.1:9191/chat
```

Send:

```text
@main@local@inst-i2 Who are you?
```

Expected result:

- the user message appears in the instance 1 chat
- a compact delivery status appears while HybridClaw sends to instance 2
- the status moves from sending to received to waiting
- the status disappears when the remote reply is stored
- the reply from `main@local@inst-i2` appears in the same instance 1 chat

## Troubleshooting

### The Admin API Says Unauthorized

Use the token configured for that instance:

```bash
-H "Authorization: Bearer $I1_TOKEN"
```

If an instance has no `WEB_API_TOKEN` configured and you are using loopback
browser access, the browser can authenticate with a local session cookie. Raw
`curl` calls still need a bearer token when the gateway asks for one.

### Pairing Trusts One Side But Replies Do Not Arrive

Check the reverse trust direction. Instance 1 trusting instance 2 is enough for
instance 1 to send. Instance 2 must also trust instance 1 to send a reply back.
Approve the pending request on instance 2, or pair instance 2 back to instance
1.

### A Peer Has No E2EE Key

Re-pair the peer so both sides pin the X25519 encryption key advertised in the
Agent Card. Do not disable the global E2EE requirement merely to bypass an
unexpected missing or changed fingerprint; verify the peer out of band first.

### Peer Notification Fails

Set `deployment.public_url` on the instance that starts pairing. For local
same-machine tests, this can be the loopback base URL for that instance:

```bash
HYBRIDCLAW_DATA_DIR="$I1_DIR" hybridclaw config set deployment.public_url "$I1_URL"
```

For two machines, use a URL that the peer machine can actually reach.

### The Agent ID Looks Wrong

Use `agent-slug@user-slug@instance-id`, for example
`main@local@inst-i2`. The middle component is not the transport; it is the
owner or user routing namespace.

### The Message Is Delivered But No Reply Appears

Open the receiving instance's A2A inbox at `/admin/federation?tab=inbox` and check the
gateway logs. The receiving instance must have an available target agent, and
the reply can only be sent when reverse trust is present.
