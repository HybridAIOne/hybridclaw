---
title: Twilio Voice
description: Configure the Twilio ConversationRelay voice channel, expose the webhook safely, place test calls, and troubleshoot common setup failures.
sidebar_position: 6
---

# Twilio Voice

HybridClaw's phone channel uses Twilio ConversationRelay.

That means:

- Twilio handles speech-to-text and text-to-speech.
- HybridClaw receives text turns over WebSocket instead of raw audio frames.
- The same gateway can handle inbound calls and place outbound calls through
  Twilio's Calls API.

This guide covers the Twilio-specific setup. For local file-based speech
generation and generic audio tooling, see
[Voice And TTS](./voice-tts.md).

## What You Need

- a Twilio account with Voice enabled
- a Twilio phone number that can handle voice calls
- a public `https://` base URL that Twilio can reach
- the matching public `wss://` websocket path on the same gateway
- the Twilio auth token stored in HybridClaw's encrypted secret store

Important:

- do not keep the Twilio auth token in plaintext config if you can avoid it
- do not rely on `localhost` or `127.0.0.1` for Twilio callbacks
- restart the gateway after changing Twilio voice config or secrets

## How The Channel Works

The flow is:

1. Twilio sends an inbound webhook to HybridClaw.
2. HybridClaw returns TwiML with `<Connect><ConversationRelay>`.
3. Twilio opens the relay websocket.
4. Twilio streams user speech as text.
5. HybridClaw streams response text back.
6. Twilio speaks that response to the caller.

For outbound calls, `hybridclaw gateway voice call <number>` tells Twilio to
dial the destination and point the live call back at the same HybridClaw voice
webhook.

## Minimum Config

Use either `/admin/channels` or `~/.hybridclaw/config.json`.

Minimal config:

```json
{
  "channelInstructions": {
    "voice": "This is a live phone call. Produce plain spoken text only."
  },
  "ops": {
    "gatewayBaseUrl": "https://voice.example.com"
  },
  "voice": {
    "enabled": true,
    "provider": "twilio",
    "twilio": {
      "accountSid": "your-twilio-account-sid",
      "authToken": "",
      "fromNumber": "+14155550123"
    },
    "relay": {
      "ttsProvider": "default",
      "voice": "en-US-Journey-D",
      "transcriptionProvider": "default",
      "language": "en-US",
      "interruptible": true,
      "welcomeGreeting": "Hello! How can I help you today?"
    },
    "webhookPath": "/voice",
    "maxConcurrentCalls": 8
  }
}
```

Notes:

- `channelInstructions.voice` lets you tune voice-specific prompt guidance
  without editing agent bootstrap files. Keep it short and spoken-language
  focused.
- `ops.gatewayBaseUrl` must be the public URL Twilio sees, not a local one.
- `voice.webhookPath` controls the base path for:
  - `<webhookPath>/webhook`
  - `<webhookPath>/relay`
  - `<webhookPath>/action`
- `voice.twilio.fromNumber` must be an E.164 number like `+14155550123`.
- leave `voice.twilio.authToken` empty when you store the real token in the
  encrypted secret store.

## Store The Twilio Secret

HybridClaw expects the Twilio auth token in the encrypted runtime secret store.

Local TUI or local web chat:

```text
/secret set TWILIO_AUTH_TOKEN your-real-token
```

Config file:

```json
{
  "voice": {
    "twilio": {
      "authToken": {
        "source": "store",
        "id": "TWILIO_AUTH_TOKEN"
      }
    }
  }
}
```

Admin console:

1. open `/admin/channels`
2. select `Voice`
3. set `Twilio auth token`
4. optionally update `Channel instructions` for spoken-style rules such as
   "keep replies short" or "do not read markdown aloud"
5. save

Important:

- setting the secret updates the stored credential immediately
- use `/secret set ...`, `hybridclaw secret set ...`, `/admin/channels`, or a
  SecretRef-backed `voice.twilio.authToken` value
- the voice runtime itself is safest after a gateway restart
- if voice was previously disabled because the token was missing, do not assume
  it became active until the gateway has restarted and logged successful voice
  startup

## Expose The Webhook Publicly

Twilio must be able to reach both:

- `https://<public-host><voice.webhookPath>/webhook`
- `wss://<public-host><voice.webhookPath>/relay`

For local development, use a public tunnel or reverse proxy such as:

- Cloudflare Tunnel
- ngrok
- Tailscale Funnel or Serve
- a normal reverse proxy on a public host

If you terminate TLS upstream, make sure the public host and scheme still match
`ops.gatewayBaseUrl`.

Practical rule:

- if Twilio sees `https://voice.example.com`, set
  `ops.gatewayBaseUrl = "https://voice.example.com"`

## ngrok Commands For Local Development

If your gateway is running on the local default port `9090`, the minimal ngrok
workflow on macOS is:

```bash
brew install ngrok
ngrok config add-authtoken <YOUR_NGROK_TOKEN>
hybridclaw gateway restart --foreground
```

If you are testing local source changes from this repository, rebuild before
using the linked `hybridclaw` binary. It runs `dist/cli.js`, so edits in
`src/` are not live until `dist/` is refreshed.

```bash
npm run build
npm run gateway -- restart
```

For fast iteration, prefer the repo entrypoint directly:

```bash
npm run gateway -- restart
```

In a second terminal:

```bash
ngrok http 9090
```

ngrok will print a public URL such as:

```text
https://abc123.ngrok.app
```

Set that as HybridClaw's public base URL:

```bash
hybridclaw config set ops.gatewayBaseUrl https://abc123.ngrok.app
hybridclaw gateway restart --foreground
hybridclaw gateway voice info
```

Then point Twilio at:

```text
https://abc123.ngrok.app/voice/webhook
```

If you changed `voice.webhookPath`, replace `/voice` with your configured path.

Practical loop for local testing:

```bash
# terminal 1
hybridclaw gateway restart --foreground

# terminal 2
ngrok http 9090

# terminal 3, after copying the ngrok URL
hybridclaw config set ops.gatewayBaseUrl https://abc123.ngrok.app
hybridclaw gateway restart --foreground
hybridclaw gateway voice info
```

Important:

- prefer top-level `hybridclaw config set ...` here because it edits the local
  config file directly
- ngrok HTTP endpoints support WebSocket upgrades automatically, so the same
  ngrok host works for both the Twilio webhook and the ConversationRelay relay
  socket
- free ngrok URLs usually change every time you restart ngrok
- when the URL changes, update `ops.gatewayBaseUrl` and the Twilio phone number
  webhook URL again
- use `hybridclaw gateway voice info` after every ngrok URL change to confirm
  HybridClaw is generating the right public webhook URL

## Point Twilio At HybridClaw

In the Twilio console, configure your Twilio number's voice webhook to:

```text
https://voice.example.com/voice/webhook
```

Use `POST`.

If you changed `voice.webhookPath`, use that path instead of `/voice`.

HybridClaw will generate the matching relay and action URLs automatically from
the same base path.

## Start And Verify

After config and secrets are in place:

```bash
hybridclaw gateway restart --foreground
```

Then verify:

```bash
hybridclaw gateway status
hybridclaw gateway voice info
```

What you want to see:

- voice enabled
- account SID configured
- from number configured
- auth token configured from the secret store
- a public webhook URL, not `localhost`

Expected gateway startup log:

```text
Voice integration started inside gateway
```

Common startup failures:

- `Voice integration disabled in config`
- `Voice integration disabled: Twilio credentials are incomplete`

## Test Inbound Calls

Once the public webhook is configured on the Twilio number:

1. call your Twilio number from your phone
2. wait for the welcome greeting
3. speak a short question
4. confirm the assistant responds
5. interrupt while it is speaking if `interruptible` is enabled

If the phone rings but the conversation never starts, the usual causes are:

- `ops.gatewayBaseUrl` does not match the public host
- the relay websocket is not publicly reachable over `wss://`
- the gateway was not restarted after setting the Twilio secret

## Test Outbound Calls

CLI:

```bash
hybridclaw gateway voice call +4915123456789
```

TUI:

```text
/voice call +4915123456789
```

Info command:

```bash
hybridclaw gateway voice info
```

The outbound command:

- validates the number as E.164
- checks that voice is enabled
- checks that `TWILIO_AUTH_TOKEN` is available from the secret store
- refuses to dial if `ops.gatewayBaseUrl` still points at `localhost`
- returns the Twilio `CallSid` and the initial Twilio call status

Important:

- the command places the call through Twilio
- the live conversation still depends on the inbound webhook and relay path
- if the voice runtime is not actually running, Twilio may dial successfully
  but fail when it tries to connect the relay websocket

## Admin Console Workflow

The fastest operator path is:

1. open `/admin/channels`
2. enable `Voice`
3. enter the Twilio account SID
4. store the Twilio auth token in the secret field
5. set the Twilio number in E.164 format
6. confirm the webhook path
7. save and restart the gateway

Use the admin UI when you want a persistent config workflow. Use TUI or CLI
when you want quick local testing.

## Tips And Tricks

- Keep `voice.webhookPath` short and predictable. `/voice` is easier to debug
  than deep nested proxy paths.
- Set `ops.gatewayBaseUrl` even if your proxy forwards headers correctly. It
  makes outbound calling and generated callback URLs more deterministic.
- Start with `interruptible: true`. That feels more natural on live phone
  calls.
- Use a short welcome greeting. Long greetings slow down the first exchange and
  make troubleshooting harder.
- Test with your own phone first before routing public traffic.
- If you are on a Twilio trial account, verify the destination number you want
  to call before testing outbound dialing.
- Twilio trial voice calls play a short trial announcement before your TwiML is
  executed. The called party must press a digit to continue into the live
  HybridClaw session.
- The current outbound `voice call` command returns success to the caller but
  does not yet write a dedicated outbound dial info log line. Use the command
  result and Twilio Console call logs together.

## Troubleshooting

### No voice startup log appears

Check:

- `voice.enabled` is `true`
- `voice.twilio.accountSid` is set
- `voice.twilio.fromNumber` is set
- `TWILIO_AUTH_TOKEN` exists in the encrypted secret store
- the gateway was restarted after the secret was added

### `voice call` says the webhook is not public

Set:

```json
{
  "ops": {
    "gatewayBaseUrl": "https://voice.example.com"
  }
}
```

`http://127.0.0.1:9090` and `http://localhost:9090` are valid local gateway
addresses for your browser, but not for Twilio.

### Twilio reaches the webhook but the call still fails

The usual causes are:

- the relay path is blocked or not upgraded to WebSocket
- TLS termination is configured for HTTPS but not WSS
- the public hostname in `ops.gatewayBaseUrl` is different from the one Twilio
  actually uses
- the voice runtime never started because the gateway was not restarted after a
  secret or config change

### The called phone hears a Twilio trial message and then the call ends

That is expected on a Twilio free trial account.

Twilio plays a short trial announcement before your TwiML is executed. The
called party must press any touch-tone digit to continue into the actual call
flow.

Check:

- answer the call yourself instead of relying on voicemail or call screening
- press a digit after the trial announcement
- verify the destination number in Twilio's Verified Caller IDs list if you are
  still on a trial account

If the call still ends after you press a digit, then you are past the trial
announcement and the next thing to inspect is the HybridClaw voice webhook and
relay path.

### Signature validation fails

Check:

- the stored `TWILIO_AUTH_TOKEN` is correct
- your reverse proxy preserves the public scheme and host
- `ops.gatewayBaseUrl` matches the external URL Twilio is calling

## Official Twilio References

- [ConversationRelay Overview](https://www.twilio.com/docs/voice/conversationrelay)
- [ConversationRelay TwiML `<ConversationRelay>`](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay)
- [Twilio Calls Resource](https://www.twilio.com/docs/voice/api/call-resource)
