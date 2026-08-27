---
title: Vonage Voice Plugin
description: Install and configure turn-based or realtime phone calls through the Vonage Voice API.
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

Optional settings are `mode` (`turn` or `realtime`), `language`,
`welcomeGreeting`, `interruptible`, and `maxConcurrentCalls`.

## Vonage Application

Create a voice-capable Vonage Application, enable signed callbacks, link your
Vonage number, and configure these `POST` endpoints:

- answer: `https://voice.example.com/api/plugin-webhooks/vonage-voice/answer`
- event: `https://voice.example.com/api/plugin-webhooks/vonage-voice/event`

The plugin places its input callback URL in each NCCO automatically.

In the default turn mode, Vonage handles speech recognition and
text-to-speech. Calls are turn-based: the caller speaks, HybridClaw processes
the completed transcript, then the plugin transfers the live call to an NCCO
that speaks the finished reply.

## Realtime Mode

```text
/plugin config vonage-voice mode realtime
```

Realtime mode runs calls as natural speech-to-speech conversations with
instant barge-in, using the gateway's realtime voice engine — the same
`speech.realtime.*` settings (provider, model, voice, instructions) and
credential (`OPENAI_API_KEY` or the HybridAI provider) that power the Twilio
realtime mode and the web console voice mode. The Twilio channel itself can
stay disabled. Answered calls where no realtime credential is configured are
declined with a spoken notice instead of connecting silently.

The answer webhook connects the call's audio to a plugin websocket at
`/api/plugin-webhooks/vonage-voice/stream`, carrying linear PCM at 8 kHz in
both directions. Each call's websocket URL embeds a single-use stream token
that expires after 30 seconds, since Vonage does not sign websocket upgrades.
The realtime model fronts the conversation and forwards substantive requests
to the full agent, so approvals, audit, and session history keep working;
spoken turns persist into the call's session transcript. In realtime mode the
`interruptible` setting is ignored (barge-in is always on) and DTMF digits are
not delivered.

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
