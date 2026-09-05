---
title: OpenAI-Compatible API
description: Send prompts to an agent from an external system over the gateway's OpenAI-compatible /v1 endpoints, using a scoped API token.
sidebar_position: 9
---

# OpenAI-Compatible API

The gateway exposes `/v1/models` and `/v1/chat/completions` in the OpenAI
chat-completions shape. A request is a **real agent turn** — the selected agent
answers with its own workspace, skills, tools, and approvals — so any external
system that already speaks the OpenAI API can send a prompt and read the
answer without a HybridClaw-specific client.

Use it for backend-to-backend integrations: an ERP, a ticket system, a CRM
workflow, an eval harness, or your own service calling the agent over HTTP.
There is no SOAP endpoint; put an adapter in front of the gateway if a SOAP
client is a hard requirement.

For browser voice sessions see
[Realtime Voice for Web Apps](./voice-web-api.md); for the chat UI transport
see [Runtime](../developer-guide/runtime.md).

## 1. Create a scoped API token

Create a token that can only call the OpenAI-compatible surface:

```bash
hybridclaw token create --label "erp integration" --actions openai.api
```

- The `hck_` value is shown **once** at creation time; store it in your
  caller's secret store.
- `/admin/credentials?tab=api-tokens` offers the same create/list/revoke
  workflow in the browser.
- A token missing the `openai.api` action gets `403 Forbidden` from `/v1/*`.
- `WEB_API_TOKEN` and `GATEWAY_API_TOKEN` are also accepted, but they are
  broad master credentials — prefer a scoped token you can revoke on its own.

Keep the token server-side. Every holder can spend model budget and run agent
turns with tools on your gateway.

## 2. Reach the gateway

Locally that is the loopback listener:

```bash
curl http://127.0.0.1:9090/v1/models \
  -H "Authorization: Bearer hck_..."
```

From another machine the gateway must be reachable over HTTPS — a
[Tailscale Funnel](./tailscale-funnel.md), a
[Cloudflare tunnel](./cloudflare-tunnel.md), an
[SSH tunnel](./remote-access.md), or a hosted deployment's public hostname.
Loopback is not an authentication boundary: `/v1/*` requires a bearer token
either way.

## 3. Send a prompt

```bash
curl https://gateway.example/v1/chat/completions \
  -H "Authorization: Bearer hck_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hybridai/gpt-4.1-mini",
    "messages": [{"role": "user", "content": "Summarize today's open tickets."}]
  }'
```

- `model` is required and must be one the gateway can serve — list them with
  `GET /v1/models`.
- The final message must have role `user` (unless the request carries client
  tool definitions).
- `stream: true` returns standard SSE chunks; add
  `"stream_options": {"include_usage": true}` for a final usage chunk.
- `user` is optional and labels the turn in session history.
- Image and file URLs in message content are passed through as media.

Every request runs as a **fresh session**: earlier messages in the `messages`
array are replayed as history for that turn, and nothing is carried over
implicitly between calls. Your caller owns the conversation state — send the
transcript you want the agent to see.

Because these are OpenAI-shaped endpoints, the official OpenAI SDKs work by
pointing `base_url` at `https://gateway.example/v1` and passing the `hck_`
token as the API key.

## 4. Choose which agent answers

Without an explicit selection the turn runs as the built-in `main` agent. This
is a fixed fallback on this endpoint: `agents.defaultAgentId` in the runtime
config steers other surfaces, but `/v1/chat/completions` does **not** read it.

Select a specific agent by appending an agent flag to the model id:

```bash
curl https://gateway.example/v1/chat/completions \
  -H "Authorization: Bearer hck_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hybridai/gpt-4.1-mini__hc_eval=agent=support-desk",
    "messages": [{"role": "user", "content": "Which orders are stuck?"}]
  }'
```

The same profile can travel in a header instead, which keeps the model id
clean for OpenAI SDKs that validate it:

```bash
-H "X-HybridClaw-Eval-Profile: agent=support-desk"
```

- The agent id is the workspace id shown by `hybridclaw agent list` — not the
  display name.
- An unknown id does **not** fail the request: it runs a default-shaped agent
  under that id, so verify the id rather than trusting a 200.
- Further flags are comma-separated after the marker (`fresh-agent`,
  `ablate-system`, `include=`, `omit=`) — those belong to the eval harness, see
  [Commands](../reference/commands.md).

> **Tools are auto-approved when an agent profile is present.** The marker and
> the header both flag the request as an eval-profile request, which runs the
> turn with tool approvals bypassed. Only hand out tokens for agent-selected
> integrations to callers you would also trust to approve that agent's tools.

## 5. Handle delegated answers

When the agent hands work to sub-agents, the completion returns an
acknowledgement instead of the final answer, plus a delegation descriptor:

```json
{
  "hybridclaw": { "delegation": { "id": "chatcmpl-…", "status": "queued" } }
}
```

Non-streaming responses also set the `X-HybridClaw-Delegation-Id` header;
streaming responses carry the same object on the final stop chunk. Poll the
job until it finishes:

```bash
curl https://gateway.example/v1/chat/completions/<completion-id> \
  -H "Authorization: Bearer hck_..."
```

- top-level `status` is one of `queued`, `in_progress`, `completed`, `failed`,
  or `cancelled`
- while queued or running, the retrieval returns the acknowledgement with
  `finish_reason: null`; when completed it returns the synthesized final answer
  with `finish_reason: "stop"`; a failed job carries a top-level OpenAI-shaped
  `error`
- poll every 1–5 seconds — a job may wait behind the delegation concurrency
  limit before it starts

A caller that ignores this path will occasionally store "Started 1 delegate
job." as if it were the answer, so handle it before going live.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401` with `Unauthorized. Set 'Authorization: Bearer <WEB_API_TOKEN>'.` | No bearer token, or a revoked/expired one |
| `403 Forbidden` | The token lacks the `openai.api` action |
| `400` `Missing 'model' in request body.` | `model` is required on every request |
| `400` `The final chat message must have role 'user'.` | Last entry in `messages` is not a user turn |
| `400 Unknown HybridClaw eval profile flag` | Typo in the `__hc_eval=` flag list |
| The wrong agent answers | No agent flag was sent, so the turn ran as `main` |
