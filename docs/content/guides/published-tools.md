---
title: Published Tools (MCP)
description: Publish admin-defined tools on an MCP endpoint so Microsoft Copilot and other MCP hosts can hand tasks to a HybridClaw agent.
sidebar_position: 9
---

# Published Tools (MCP)

The `published-tools` plugin serves an MCP endpoint (Streamable HTTP, protocol
version `2026-07-28`). Each tool on it is one you define in HybridClaw: a
name, a description the host's model reads to decide when to call it, and
instructions only HybridClaw reads. Every call runs a normal agent turn,
with the agent's skills, credentials, model routing, approvals, and audit.

Use it to add HybridClaw to an assistant that already speaks MCP, such as a
Microsoft Copilot Studio agent: Copilot decides *when* to call, and
HybridClaw does the work.

## Install

```bash
hybridclaw plugin install ./plugins/published-tools
hybridclaw secret set PUBLISHED_TOOLS_TOKEN "replace-with-a-long-random-token"
```

The endpoint is `POST /api/plugin-webhooks/published-tools/mcp` on your
gateway's public URL. Every request must send
`Authorization: Bearer <PUBLISHED_TOOLS_TOKEN>`. Without the secret, the
endpoint rejects every request.

## Define Tools

Tools live in the plugin config as a `tools` array:

```bash
hybridclaw plugin config published-tools tools '[
  {
    "name": "ask_sales_pipeline",
    "title": "Sales pipeline",
    "description": "Use for questions about Salesforce pipeline, forecast, win rates and deal slippage. Do not use for email drafting or documents.",
    "instructions": "Answer from Salesforce opportunities via the salesforce skill. Pipeline means open opportunities in stage 2 or later. Reply with a short answer and a small table.",
    "agentId": "sales",
    "allowedTools": ["bash", "read"]
  }
]'
```

| Field | Read by | Meaning |
| --- | --- | --- |
| `name` | host | Tool name, letters, digits, `_`, `.`, `-` |
| `title` | host | Optional display name |
| `description` | host | When to call the tool. Say what it is for, what it is not for, and give example questions |
| `instructions` | HybridClaw | Added to the agent's system prompt for these calls only; never sent to the host |
| `agentId` | HybridClaw | Agent that answers; defaults to the default agent |
| `allowedTools` | HybridClaw | Required. Tools this published tool may use, intersected with the agent's own tool list. `["*"]` keeps the agent's list unchanged |

Server-wide guidance for the host goes in `instructions` at the top level of
the plugin config. `syncWaitSeconds` (default 20) sets how long a call waits
for the answer before it returns a `run_id`.

## Calling Contract

Every published tool takes `question` (required) and `conversation_id`
(optional). The result's `structuredContent.status` is one of:

- `completed`: `answer` holds the reply; pass the returned
  `conversation_id` to ask a follow-up in the same conversation.
- `running`: the turn outlasted `syncWaitSeconds`. Call
  `hybridclaw_get_result` with the `run_id`; it waits briefly and returns the
  answer or `running` again.
- `approval_required`: the turn needed an action that requires human
  approval. See below.
- `failed`: the turn failed, or the input was invalid.

A conversation belongs to the tool that started it, and only one request per
conversation runs at a time.

## Approvals

The caller of an MCP tool is a model, so HybridClaw never takes an approval
through this endpoint. When a turn stops at an approval, the action does not
run, the tool returns `approval_required`, and that conversation is closed
for good, so a later "yes" on it cannot approve the action. Keep published
tools to actions that need no approval, narrow them with `allowedTools`, and
point write-capable work at channels where a person answers approval
prompts.

## Microsoft Copilot Studio

1. In your Copilot Studio agent, add a tool of type **Model Context
   Protocol** and enter the endpoint URL.
2. Choose API key authentication, sent as a Bearer token in the
   `Authorization` header, with the `PUBLISHED_TOOLS_TOKEN` value.
3. In the agent's instructions, tell Copilot when to call the HybridClaw
   tools. For example: "For questions about Salesforce data, always call
   ask_sales_pipeline; never answer from memory."
4. Publish the agent to Teams and Microsoft 365 Copilot.

The endpoint implements only protocol version `2026-07-28`. A host that still
opens with an `initialize` handshake (versions `2025-11-25` and earlier)
receives an `UnsupportedProtocolVersion` error that names `2026-07-28`, and
cannot connect.

## Limits

- One bearer token per gateway. Every caller shares one HybridClaw identity,
  so per-user memory does not apply to published tools.
- In-flight runs live in gateway memory. After a gateway restart,
  `hybridclaw_get_result` reports the `run_id` as unknown. Conversations
  survive restarts.
- Responses are single JSON objects: no SSE progress, no
  `subscriptions/listen`, no resources or prompts.
