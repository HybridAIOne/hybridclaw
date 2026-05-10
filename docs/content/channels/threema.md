---
title: Threema
description: Configure HybridClaw to send outbound Threema Gateway messages.
sidebar_position: 7
---

# Threema Channel

HybridClaw can send outbound text through Threema Gateway Basic mode. Basic mode
does not provide inbound messages, so this channel is currently for proactive
delivery and explicit `message` tool sends.

## Setup

Create a Threema Gateway ID, then configure HybridClaw with the ID and Gateway
secret:

```bash
hybridclaw channels threema setup \
  --identity '*HYBRID1' \
  --secret <gateway-secret>
```

The setup command stores the secret in the runtime credential store and writes a
secret reference under `threema.secret`.

## Sending

Supported targets:

```text
threema:ABCDEFGH
threema:phone:41791234567
threema:email:user@example.com
```

Agents can send through the message tool:

```json
{"action":"send","to":"threema:ABCDEFGH","content":"Message text"}
```

Attachments, reactions, typing indicators, and inbound chat history are not
available in the Basic-mode integration.

## Config Fields

- `threema.enabled`: starts the channel when true.
- `threema.apiBaseUrl`: Threema Gateway API base URL.
- `threema.identity`: Gateway sender ID.
- `threema.secret`: Gateway secret or a runtime secret reference.
- `threema.dmPolicy`: outbound availability switch for this Basic-mode channel; use `allowlist` to allow sends or `disabled` to keep the transport off.
- `threema.allowFrom`: reserved allowlist for future inbound support.
- `threema.textChunkLimit`: maximum outbound text chunk size.
- `threema.outboundDelayMs`: delay between chunked messages.
