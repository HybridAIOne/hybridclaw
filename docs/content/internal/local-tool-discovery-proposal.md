---
title: Local Tool Discovery
description: Fixed starter tools with bounded discovery and normal action approval.
---

# Local tool discovery

Implemented for local model requests following the owner's 2026-09-10 request.
The compact catalog addresses the 114-tool Spark context overflow. Starter
selection is configurable at instance and agent scope.

## Model-facing contract

By default, local provider requests expose nine basic tools when allowed by
the agent's existing policy: `read`, `write`, `edit`, `bash`, `glob`, `grep`,
`skills_list`, `web_search`, and `web_fetch`. The owner selected nine plus one
on 2026-09-10; `memory` is available through discovery.

The instance default is `tools.localStarterTools`; an agent can replace it
with `agents.list[].localStarterTools` in runtime configuration. Omitted or
`null` agent values inherit; `[]` exposes discovery only. Lists accept at most
nine unique non-empty names, including installed MCP/plugin tools. The reserved
`tool_catalog` name cannot be a starter. Blocked or unavailable selections are
omitted; they never grant permissions. Settings apply to the next request,
including requests handled by a pooled worker.

One additional `tool_catalog` tool provides three actions:

| Action | Input | Result |
| --- | --- | --- |
| `list` | optional keyword `query` and page `offset` | At most ten remaining tool names and short descriptions, with a next-page offset |
| `describe` | exact tool `name` | One complete input schema, subject to a size bound |
| `call` | exact tool `name` and an `arguments` object | The normal tool result, after the usual policy and approval checks |

Names and descriptions are searched deterministically. Schemas are returned
only for selected tools. Model-facing definitions remain fixed for the turn;
there is no expanding tool array or replacement of earlier messages. Remote
model requests keep their current tool catalog. The trigger is the existing
`isLocal` runtime flag, which also covers configured Ollama, LM Studio, and
vLLM endpoints; this does not assert that their endpoints are on the same Mac.

## Runtime integration and boundaries

The catalog is built from `resolveTools` in `container/src/index.ts`, after
`allowedTools` and `blockedTools` filtering. It cannot reveal or execute tools
outside that filtered snapshot. If no deferred tools remain, the discovery
tool is omitted.

`tool_catalog` calls are validated and unwrapped to the real tool name and
arguments before approval evaluation, parallelism decisions, security hooks,
loop detection, progress, and audit. For example, invoking `bash` through the
catalog must receive exactly the checks that a direct `bash` call receives.
The assistant's original catalog call and its ID remain intact in model
history; the resulting tool response uses that same ID.

Only `list` and `describe` qualify as read-only catalog actions in
`container/src/approval-policy.ts`. No generic catalog executor bypasses the
existing dispatch path. Approval replay rechecks current tool availability,
so disabling a tool while approval is pending prevents execution.

Catalog names are reserved; unknown targets, recursive catalog invocation,
malformed arguments, and unavailable tools fail before dispatch. Page size,
description length, and individual schema size are bounded. Oversized schemas
return an explicit error rather than truncated, invalid JSON. These bounds do
not guarantee that arbitrary tool results or long conversations fit; the
existing context guard and native context limit remain necessary.

## Verification boundaries

The focused check includes 196 unit tests and four real IPC/model-HTTP
integration tests. Typecheck, root/container lint, formatting, and the full
build passed. Native GPU inference and the full PDF workflow remain unverified:
the existing MLX endpoint refused the live health connection.


- Check the model request contains only the permitted starter tools and
  discovery; cloud requests retain their full catalogs.
- Exercise list, search, pagination, describe, and call through the real agent
  IPC loop against a synthetic model endpoint. Verify tool definitions and
  historical assistant calls stay unchanged after discovery.
- Verify MCP/plugin dispatch and artifact capture use the real tool identity.
- Verify allow/block filters on listing, description, direct calls, catalog
  calls, and approval replay; test malformed and recursive calls.
- Verify red/denied actions cannot inherit read-only discovery approval,
  security hooks receive the underlying action, and `bash` remains sequential.
- Test per-request isolation in a pooled runtime and bounded discovery output.
- Run targeted tests, root/container lint, typecheck, and the full build.
- Run a separate local inference qualification for discovery followed by tool
  execution; PDF creation remains unqualified until its full workflow passes.

## Token comparison

Using the installed Spark tokenizer and a reconstruction of the recorded
request, the full 114-tool catalog needs 52,439 tokens including a 2,048-token
output reserve. The ten default definitions need 21,292 tokens with the
same reserve, leaving 19,668 tokens below the 40,960 limit. No model generation,
MCP tool execution, runtime reconfiguration, or restart was used for this
comparison. See the [qualification record](mac-inference-qualification.md).
