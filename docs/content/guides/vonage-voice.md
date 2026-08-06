---
title: Vonage Voice Plugin
description: Install and configure turn-based phone calls through the Vonage Voice API.
sidebar_position: 8
---

# Vonage Voice Plugin

Vonage Voice is an install-on-demand channel plugin. The built-in `voice`
channel remains the Twilio ConversationRelay integration; enabling Vonage does
not add provider keys or secrets to the core runtime config.

## Install

```bash
hybridclaw plugin install ./plugins/vonage-voice
```

Configure the plugin:

```text
/plugin config vonage-voice applicationId your-application-id
/plugin config vonage-voice fromNumber +14155550123
/plugin config vonage-voice publicBaseUrl https://voice.example.com
```

Store `VONAGE_PRIVATE_KEY` and `VONAGE_SIGNATURE_SECRET` through HybridClaw's
credential flow. Do not put either secret in plugin config.

Optional settings are `language`, `welcomeGreeting`, `interruptible`, and
`maxConcurrentCalls`.

## Vonage Application

Create a voice-capable Vonage Application, enable signed callbacks, link your
Vonage number, and configure these `POST` endpoints:

- answer: `https://voice.example.com/api/plugin-webhooks/vonage-voice/answer`
- event: `https://voice.example.com/api/plugin-webhooks/vonage-voice/event`

The plugin places its input callback URL in each NCCO automatically.

Vonage handles speech recognition and text-to-speech. Calls are turn-based:
the caller speaks, HybridClaw processes the completed transcript, then the
plugin transfers the live call to an NCCO that speaks the finished reply.

## Verify And Call

```text
/vonage info
/vonage call +4915123456789
```

`/vonage info` prints the exact answer and event URLs derived from
`publicBaseUrl`. Outbound destinations and the configured source number must
use E.164 format.

Unsigned, stale, body-tampered, or replayed callback JWTs are rejected. If a
call connects without a greeting, confirm signed callbacks are enabled and the
account signature secret is correct.
