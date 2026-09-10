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
| `list` | optional keyword `query` and page `offset` | Up to ten ranked summaries, required field names, and exact next calls to describe matching tools |
| `describe` | exact tool `name` | One complete input schema, subject to a size bound |
| `call` | exact tool `name` and an `arguments` object | The normal tool result, after the usual policy and approval checks |

Names, descriptions, and parameter names are searched deterministically with
multiple keywords. Exact names rank highest. Schemas are returned only for
selected tools. A miss preserves the permitted tool count and explains how to
broaden the query or browse. Search results include the exact `next.name` and
`next.arguments` to request a schema. Model-facing definitions remain fixed for the turn;
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

## Staged skill discovery

The 2026-09-10 owner request pointed to Hermes Agent's progressive discovery
implementation (`tools/tool_search.py` and `tools/skills_tool.py`). HybridClaw
uses the same separation of summaries, details, and execution while retaining
the owner's nine-starters-plus-one-directory budget. It does not add Hermes's
three separate bridge schemas to every local request.

`skills_list` search results contain short routing metadata and pagination.
Selecting an exact skill name returns full metadata plus a concrete next call
to read the SKILL.md. That next call reflects this request's actual exposure:
`read` when direct, a `tool_catalog` call when deferred, and null when read is
blocked or unreachable. The directory does not read files or execute skill
content. Existing read controls and linked-file handling remain authoritative.
The eligible catalog and exposure snapshot reset between pooled requests.

## Argument validation and verification

Deferred calls validate their argument objects against the selected tool's
JSON Schema before resolving to the underlying action. The existing MCP SDK's
AJV validator is used without coercion or external reference resolution, with
an isolated compiled validator per tool to prevent schema-id collisions.
Invalid arguments share the two-correction budget with malformed catalog calls
and missing descriptions. The error points back to the schema step without
echoing argument values. Unsupported or unresolvable schemas fail closed.
A malformed batch executes no siblings. Mixed starter/catalog batches receive
correction only when every called function is exposed; unexposed names remain
fatal. Approvals still evaluate the real
action, and approval replay still rechecks current permissions.

Targeted tests cover search ranking, summary/detail separation, pagination,
allowed and blocked read routing, request resets, nested schema violations,
external references, schema-id collisions, and corrective errors. Real worker
IPC tests exercise the staged flow, schema/history stability, blocked targets,
security hooks, destructive-action approval, replay, and rejecting malformed
batches before any action. Native model qualification is recorded separately
in the [qualification record](mac-inference-qualification.md).

## Token comparison

Using the installed Spark tokenizer and a reconstruction of the recorded
request, the full 114-tool catalog needs 52,439 tokens including a 2,048-token
output reserve. The ten default definitions need 21,292 tokens with the
same reserve, leaving 19,668 tokens below the 40,960 limit. No model generation,
MCP tool execution, runtime reconfiguration, or restart was used for this
comparison. See the [qualification record](mac-inference-qualification.md).
