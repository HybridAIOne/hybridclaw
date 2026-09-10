---
title: Mac Local Model Setup
description: Select, install and test a pinned MLX model using your Mac's unified-memory budget.
---

# Mac Local Model Setup

On Apple silicon with macOS 15 or later, open **Labs → Local Models** in the
web console. The setup page, navigation and search entry appear only when the
gateway runs on a supported Apple silicon Mac with unified memory. Intel Macs,
Windows and Linux hosts do not show this setup entry. It shows the gateway Mac’s memory, free storage and a recommended
model from the current shortlist. Use **Compare models** for other candidates
and their availability. **Download & set up** starts installation and local
checks; progress continues when you leave the page. Use **Cancel** to stop it.
After setup, **Start model** loads it, connects it to the chat model picker, and
preserves your default model. **Stop model** releases its memory. If a running
model has lost its provider connection, **Connect to chat** restores it without
restarting the model. `hybridclaw local serve` also restores this connection.
An installed model is marked **Installed** in comparison and is not offered
again as a setup recommendation. Other fitting models remain selectable.
Select the installed model in chat to use it.

**Live activity** shows the last minute of Mac-wide CPU, memory and GPU readings,
updated every 2.5 seconds while the page is visible. Memory usage is estimated
from total memory minus free and reclaimable inactive pages. GPU utilization
comes from macOS; unsupported or missing readings stay unavailable. **Tokens**
shows the local model's generated tokens per second and total since its last
start, including reasoning and tool-call output. The first rate needs two
samples. Token counters require the current MLX runtime; after an update,
restart the gateway and start the model again. Readings stay in memory and do
not include prompts, generated text, or task identifiers.
Models assigned to the local routing zone appear first in the picker with a
green **Local** badge and a dedicated filter. The badge describes the inference
destination, not whether the model is running. If MLX was absent from the last
discovery pass, chat refreshes its authenticated model metadata before resolving
the request, without waiting for the periodic discovery interval.

Open the console directly on the gateway Mac using localhost. These controls
require full administrator access or the explicit `admin.local_models.manage`
permission; ordinary provider-edit permission does not permit native setup.
A console-started model belongs to the gateway and stops when the gateway exits.
After a gateway restart, use **Start model** again before sending a local chat.
If an updated console reports that the setup API is unavailable, restart the
gateway and refresh the page.

The desktop menu also provides **HybridClaw → Labs → Set Up Local Model…**,
or run:

```bash
hybridclaw local setup
```

Setup shows the Mac's chip, unified memory, estimated model footprint,
download size and context limit. It reserves at least 4 GiB, or 25% of RAM,
for macOS, the browser and agent tools. It also caps the budget using current
free and inactive pages, leaving another 1 GiB of that estimate unused.
Speculative pages are not counted twice. A busy Mac can therefore receive a
smaller recommendation than an idle Mac with the same RAM. It includes a working-memory allowance
and both active and retained KV caches. These are conservative estimates,
not GPU capacity measurements or model-quality rankings.

Choose a model, approve its displayed download, and wait for local checks.
Setup installs a pinned Python 3.12/MLX-LM runtime with
[uv](https://docs.astral.sh/uv/getting-started/installation/), downloads an
immutable model revision, verifies its manifest, warms the GPU and tests
streaming, usage reporting and a tool round trip. Failed checks leave the
previous default selected. `uv` must already be installed and available on PATH.
The console shows named stages rather than estimated percentage completion.
Closing the desktop setup window cancels that desktop installation; navigating
away from the console page does not cancel its gateway-owned job.

The catalog follows the supplied current model shortlist. These candidates can
be installed through the managed Mac service:

| Candidate | Downloaded weights | Idle Mac recommendation, before checking current availability |
| --- | --- | --- |
| Spark-X2.5 4B, MLX 4-bit | 2.2 GiB | 8 GiB Macs; short contexts |
| Ternary Bonsai 27B, MLX 2-bit | 7.9 GiB | 16 GiB Macs |
| Qwen3.8 27B, MLX 4-bit | 15.0 GiB | 24 GiB Macs |
| Nex-N2.5 Mini, MLX 4-bit | 18.2 GiB | 32–64 GiB Macs |

Recommendations follow the shortlist's progression among supported candidates
that fit. Every
candidate still has to pass streaming and tool checks on the user's Mac before
activation; being in the catalog is not a general quality certification.

**Compare models** in the console, **View full shortlist…** in the desktop
chooser and `local setup --list` also
show Gemma 4 12B, Qwen3.8 Flash Next, both GLM Flash EXL3 variants, DeepSeek V4
Flash Vision Exp, GLM REAP, Nex Pro and GLM-5.3. Each unavailable entry explains
its concrete runtime, format or unpublished-weight limitation. Larger memory
alone cannot make an unsupported runtime installable. The
[shortlist record](../internal/local-model-shortlist.md) links the inspected
artifacts and records those distinctions.

The post's GPU VRAM tiers are not Mac unified-memory promises. Bonsai's 8.49 GB
MLX weights alone exceed the model budget on an 8 GiB Mac once macOS is reserved.
EXL3 weights cannot load in MLX; a Mac conversion is explicitly identified when
available. MoE estimates include all resident experts. The installer does not
assume that experts or embeddings can be offloaded to NVMe without a penalty.

Spark context ranges from 2,048 to 40,960 tokens depending on available memory.
Its estimate counts nine full-attention caches and 27 bounded sliding-window
caches, including prefill headroom. Other supported models retain their
8,192-token qualification ceiling. Existing installations retain their saved
context; rerun setup for the same model to recalculate it using cached downloads.
Spark retains its default reasoning mode. Each request can generate up to the
space remaining after its exact tokenized prompt; there is no separate 2,048-token
installation cap. For example, a 22,533-token prompt in a 40,960-token context
leaves 18,427 tokens for reasoning and the answer. An explicit smaller API request
limit is respected. Generation never grows beyond the installed context/memory
budget. Existing installations use this behavior after restarting the model,
without downloading the weights again.
Advertised 262K/1M limits are not allocation recommendations. Short contexts can
be exceeded by the agent's base instructions and tool schemas, even in an empty
chat. Resetting that chat cannot shrink its base prompt. Catalog
metadata lives in `src/inference/local-model-shortlist.ts`; unsupported entries
remain visible and never participate in automatic selection.

## Stars for local tools and skills

In Admin, open **Plugins & Tools → Tools** or **Skills**. The **Local model**
card on each page uses the same controls:

1. Choose **Instance default** or an agent in **Apply to**.
2. Star up to nine entries in the catalog. Click a starred chip to remove it.
3. Choose **Full** or **Starred + directory**. Changes save immediately and
   apply on the next request; use **Use instance default** to clear an override.

Use the catalog selector to show **All**, **Only active**, or **Only starred**
entries. Active tools exclude the instance's disabled tools; active skills must
be enabled, available, and unblocked. Starred entries follow the selected instance
or agent, including disabled stars. Search applies within the selected filter.
These display filters do not change which tools or skills are sent to the model.

For tools, the directory is `tool_catalog`, which lists, describes, and calls
other permitted tools. Both directories use progressive discovery: short
search results, selected details, then an explicit call to read or execute.
For skills, `skills_list` searches the full eligible catalog; select a result
with `name` to get its metadata and next SKILL.md read call. Mandatory `always` skills stay
in the prompt. Stars never enable a blocked or disabled tool or skill.

In starred tool mode, the prompt identifies the supplied function schemas as the
directly callable set and directs inventory questions through `tool_catalog`.
The worker also appends a stable instruction naming its actual exposed schemas
before inference. Skill instructions mentioning `read` do not expose `read`;
when absent, the model calls it through `tool_catalog`. Description is needed
only for unknown parameters; schemas and instructions already returned in the
request can be reused.
References to tool names in other instructions are workflow examples, not an
expanded callable set. A description returns the `tool_catalog` invocation
schema with the target's parameters nested under `arguments`. Every catalog
call includes `name`; a general listing uses an empty string. Missing tool
descriptions, required call fields, or arguments that violate the selected
tool schema return corrective feedback to the model,
with up to two corrections per request. A malformed call batch executes no
actions, including any valid starter calls in that batch. Calls that try to execute unavailable tools still stop the request.
After a catalog-executed action, the runtime appends a reminder
of the available functions; earlier messages and schemas stay intact. The skill
directory tool is named `skills_list`.
Keyword search ranks tool names, descriptions, and parameter names; skill
search ranks names, descriptions, and categories. Results include a `next`
call with the correct function name and arguments for the current request.
A search miss offers broader browsing rather than implying the capability is
unavailable. If a name and its parameters are already known, the model can
skip the search step. Schemas that cannot be validated locally fail before
execution; discovery does not fetch external schema references.
Directory tools run when the model calls them; they are not invoked automatically
for every message. Full skill mode already includes the eligible skill list.

A reasoning-only local response is not a completion confirmation. If generation
ends without a visible answer or tool call, the turn reports an error. Reaching
the output-token limit is reported separately from a context overflow; the
runtime preserves recorded tool results and does not synthesize “Done.”

MLX stops sustained exact reasoning cycles: at least four repetitions covering
at least 256 tokens, with cycle lengths up to 256 tokens. Visible output
and tool arguments are excluded from this reasoning guard. Near-repetitions
and paraphrased loops are not detected. Long reasoning with new content can
continue until the remaining context is used.

MLX requests use streaming internally even when the caller collects one answer.
Active streams refresh their inactivity deadline; they have no three-minute
wall-clock cutoff. Inactivity, cancellation, the admitted context, and finite
transport size bounds still stop stalled or oversized requests.

For small local models, starring `read` and `bash` avoids catalog round trips for
routine skill use. **Starred + directory** in Skills reduces the inline catalog;
Full skill mode can still make a two-tool request large. These settings remain
operator choices and do not bypass permissions.

These controls apply to local models. Tools default to starred mode; skills
default to full mode with no stars until you choose them. Full tool mode sends
the entire permitted schema list and may exceed a smaller model's context.

The configuration fields are `tools.localToolMode` / `tools.localStarterTools`
and `skills.localSkillMode` / `skills.localStarterSkills`. Modes accept `full`
or `starred`; agents may override the same fields in `agents.list[]`.

## Local starter tools

Local models receive up to nine starter tool schemas plus `tool_catalog`.
The catalog lists additional permitted tools, describes one tool's arguments,
and invokes it through the normal security hooks and approvals. Its schema
stays fixed during the tool loop; the full MCP catalog is not added to every
model request. Remote model requests retain their full catalogs.

Configure the instance default and optional per-agent replacements in
`~/.hybridclaw/config.json` (or the configured runtime home):

```json
{
  "tools": {
    "localStarterTools": [
      "read", "write", "edit", "bash", "glob", "grep",
      "skills_list", "web_search", "web_fetch"
    ]
  },
  "agents": {
    "list": [
      { "id": "main" },
      { "id": "researcher", "localStarterTools": ["read", "web_search", "web_fetch"] }
    ]
  }
}
```

Merge these fields into existing settings, retaining other agent entries.
Each list accepts zero to nine unique tool names. An omitted or `null` agent
list inherits the instance default; `[]` uses discovery only. A custom list
replaces the default rather than appending to it. Tool allowlists, disabled
tools, and approvals still apply. `tool_catalog` is added automatically when
additional permitted tools exist; disabling it with `tools.disabled` leaves
only the selected starters. Changes apply on the next request.

Compact schemas reduce prompt overhead but do not guarantee that a large
instruction set or long conversation fits every model's context window.

## Operating the service

```bash
hybridclaw local setup --list
hybridclaw local setup --model spark-x2.5-4b --yes
hybridclaw local serve
hybridclaw local benchmark
hybridclaw local stop
```

`--list --json` exposes the estimates for the desktop chooser. Setup selects
`mac-mlx/<catalog-id>` as the default and stores the endpoint credential through
HybridClaw's encrypted secret store. The service also keeps an owner-readable
token file for lifecycle control. Artifacts, installation state and benchmark
reports live in `<runtime-home>/inference/mlx/`; the usual runtime home is
`~/.hybridclaw`, or `HYBRIDCLAW_DATA_DIR` when configured. Model downloads are
retained for retry and are not automatically deleted when switching models.

The chat picker marks a detected local model with a green **Local** badge.
A model absent from the latest discovery has a red **Local · Offline** badge
in the dropdown and on the selected model; start its server before sending a
message. Unknown discovery status uses a neutral badge. While chat is open,
local status refreshes every 30 seconds, subject to request latency. Starting
or stopping a model in Labs also invalidates the cached model list.

An online model can still reject a request that exceeds its context window.
The MLX context-limit error reports the actual prompt tokens, reserved output
tokens needed for any generation, installed limit, and tool count. Tool schemas
and instructions count toward this budget even in a fresh chat. Reduce the agent's instructions or
enabled tools, or select a model with a larger context window. Other request
preparation failures are reported separately, without exposing library errors
that may contain prompt content or credentials.

During generation, MLX rejects calls to functions absent from the supplied
schemas and arguments that are not JSON objects. Its errors distinguish these
cases from memory failures using fixed messages that cannot include private
model output or library payloads. Tool discovery, eligibility, and action
approvals remain enforced by the agent runtime.

Startup and configuration saves reject malformed or unsupported endpoint
entries and defaults that reference a missing or disabled named endpoint.
The invalid file is preserved instead of saving a normalized version that
drops the endpoint. Startup identifies the configuration field and offers
the existing configuration-revision recovery flow through
`hybridclaw onboarding`. Restore the endpoint or select a configured model;
use a build that supports the endpoint's backend. These checks do not require
the local service to be running. Older builds without these checks can still
rewrite unsupported settings, so keep the CLI linked to the feature checkout
when testing an unreleased backend.

Desktop **Labs → Start Local Model** / **Stop Local Model** manage an owned service.
Sleep unloads it, wake restores it, and quitting stops it. An already-running
external service remains owned by its original launcher. The foreground CLI
retries crashes at most three times, then stops with an error. It never changes
the model or chooses a remote provider as part of recovery.

MLX inference runs outside Docker on literal `127.0.0.1:8321`. Docker workers
use a per-turn file relay on their existing `/ipc` mount. The relay fixes the
model, destination and authentication on the host; it does not publish a
network listener or accept arbitrary URLs. Host execution uses authenticated
loopback directly. You do not need to switch Docker execution to host mode.

The service accepts text chat and validated function calls. It rejects image
URLs, alternate model paths, adapters and draft models. One request is admitted
at a time; competing requests receive 429. Inference stays offline after
installation, with task-isolated, bounded prefix caches and a bounded prefill
chunk. Disconnects and turn cancellation stop active generation.

## Validation and current scope

This is the phase-1 inference foundation. It does not yet enforce confidential
task routing across every tool, memory operation, auxiliary model or configured
fallback ladder. Mandatory disclosure policy and resumable handoffs are later
phases of the [hybrid compute plan](../internal/hybrid-compute-parity-plan.md).
“The selected model runs on this Mac” is narrower than “the entire task cannot
send data elsewhere.”

The [shortlist qualification record](../internal/local-model-shortlist.md#validation)
identifies tested hardware, model revisions, performance and remaining checks. Installation
smoke tests do not establish frontier-model parity or general task correctness.

Primary artifacts: [Spark MLX](https://huggingface.co/abenzerps/Spark-X2.5-4B-MLX-4bit),
[Bonsai MLX](https://huggingface.co/prism-ml/Ternary-Bonsai-27B-mlx-2bit),
[Qwen3.8 27B MLX](https://huggingface.co/mlx-community/Qwen3.8-27B-4bit),
[Nex Mini MLX](https://huggingface.co/abenzerps/Nex-N2.5-mini-MLX-4bit).
