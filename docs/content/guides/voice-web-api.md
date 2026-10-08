---
title: Realtime Voice for Web Apps
description: Start browser realtime voice sessions from your own web app using a scoped API token and the gateway voice stream.
sidebar_position: 9
---

# Realtime Voice for Web Apps

Any web app can run a realtime speech-to-speech session against the gateway —
the same engine that powers the admin console voice mode and realtime phone
calls. The browser streams microphone audio over a websocket, the agent
answers with spoken audio, and substantive requests run as ordinary chat turns
with tools, approvals, and session history.

## Prerequisites

- Realtime voice credentials configured (`speech.realtime.provider`, see
  [Configuration](../reference/configuration.md)). `GET /api/chat/voice`
  reports `available: true` when the gateway can start sessions, plus the
  resolved `provider` (`hybridai`, `openai`, or `null` without a credential)
  and the configured `model` and `voice`.
- The gateway reachable over HTTPS from the browser (a tunnel or public
  deployment).

## 1. Create a scoped API token

Create a token that can only mint voice sessions:

```bash
hybridclaw token create --label "voice webapp" --actions voice.session
```

Keep the `hck_` token on your server. Do not embed it in a public page — every
holder can start voice sessions (and spend realtime-model minutes) on your
gateway.

## 2. Mint a stream token

Browsers cannot send an `Authorization` header on websocket upgrades, so a
session starts with a short-lived credential minted over HTTPS:

```bash
curl -X POST https://gateway.example/api/chat/voice/token \
  -H "Authorization: Bearer hck_..." \
  -H "Content-Type: application/json" \
  -d '{"userId": "visitor-123", "username": "Visitor"}'
```

```json
{
  "token": "wq0…",
  "expiresIn": 60,
  "path": "/api/chat/voice/stream?token=wq0…"
}
```

- The stream token is **single-use** and expires after 60 seconds; mint one
  per session, right before connecting.
- `userId` / `username` are optional and attribute the session's chat history;
  they default to the minting token's identity.
- The route answers CORS preflights and allows any origin for bearer-token
  clients; cookie-authenticated requests are still same-origin only. The
  recommended shape is still to mint from your backend and hand only the
  stream token to the page.

## 3. Connect and stream audio

Open a websocket to the returned `path` on the gateway host and speak the
webchat voice frame protocol — JSON text frames both ways:

| Direction | Frame | Meaning |
| --- | --- | --- |
| client → server | `{"type":"start","sessionId?":"…","agentId?":"…","client?":"mobile"}` | Start the session (within 10 s of connecting); `client: "mobile"` keeps a phone app's chat from resetting, as on `POST /api/chat` |
| client → server | `{"type":"audio","payload":"<base64 PCM16>"}` | Microphone audio |
| client → server | `{"type":"stop"}` | End the session |
| server → client | `{"type":"ready","sessionId":"…"}` | Session is live |
| server → client | `{"type":"audio","payload":"<base64 PCM16>"}` | Agent speech |
| server → client | `{"type":"clear"}` | Barge-in: drop queued playback |
| server → client | `{"type":"state","state":"listening\|speaking\|thinking"}` | Turn state |
| server → client | `{"type":"consult","label":"…"}` | Tool/agent activity label |
| server → client | `{"type":"transcript","role":"user\|assistant","text":"…"}` | Spoken-turn transcript |
| server → client | `{"type":"error"}` / `{"type":"ended"}` | Failure / session end |

Audio is 16-bit little-endian mono PCM at **24 kHz**, base64-encoded, in both
directions.

### Continuing an existing chat

Pass an existing chat's `sessionId` in the `start` frame to continue that
session by voice: spoken turns and agent requests land in the same history as
the typed messages. When the session already has stored messages, the gateway
also gives the realtime voice model a short recap of it (the session summary,
if any, and the last few user and assistant messages, about 2,400 characters
at most), so it understands references to the chat and keeps its language.
The recap is background for the voice model only and is sent to the
configured realtime provider; it is not spoken or returned in a frame. Omit
`sessionId`, or send one the gateway has not seen, to start without a recap.

Every session also starts knowing who it is and who it talks to: the voice
goes by the agent's display name (for example "Hy"), calls the user by the
name in the agent's `USER.md` ("What to call them", else "Name"), and knows
the user's local date and time from `USER.md`'s "Timezone". All of this is
read once at the `start` frame, so a client can play a ringing tone while the
realtime session connects and greets; the greeting audio arrives as soon as
the voice is ready.

Minimal client sketch:

```js
const { token } = await fetch('/my-backend/voice-token', { method: 'POST' })
  .then((res) => res.json());
const ws = new WebSocket(`wss://gateway.example/api/chat/voice/stream?token=${token}`);
ws.onopen = () => ws.send(JSON.stringify({ type: 'start' }));
ws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.type === 'audio') playPcm16Base64(frame.payload); // 24 kHz mono
  if (frame.type === 'clear') stopPlayback();
};
// Capture: AudioWorklet/ScriptProcessor at 24 kHz → Int16 PCM → base64:
// ws.send(JSON.stringify({ type: 'audio', payload: base64Chunk }));
```

## Limits

- Stream tokens: single-use, 60 s TTL, at most 32 unclaimed mints pending.
- Sessions: at most 4 concurrent voice sessions per gateway, 256 KB max
  frame size, and a 10 s deadline to send `start` after connecting.
- Spoken turns persist into session history as regular messages tagged
  `source: 'voice'`.
