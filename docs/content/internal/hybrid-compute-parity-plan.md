---
title: Hybrid Compute Parity — Four Implementation Phases
description: One persistent task across Mac inference, HybridAI GPUs, EU offers, and global offers, with enforced data boundaries and visible subagent progress.
---

# Hybrid Compute Parity — Four Implementation Phases

Planning date: 2026-09-09. Checkout inspected: `c6e966efc`.
Status: phase-1 inference and client destination contract implemented in the
checkout. See the [qualification record](mac-inference-qualification.md) for
measured results, remaining release qualification and backend dependencies.
Phases 2–4 remain planned; no production deployment was performed.

The target is the supplied Perplexity screenshot: concurrent local and remote
subtasks, visible models and resource use, controlled disclosure, and one final
artifact. Perplexity's [launch description](https://www.perplexity.ai/en-GB/hub/blog/introducing-hybrid-compute-on-mac)
documents the cloud/local split and the on-device privacy gate. Its linked
product page could not be retrieved during this review; the screenshot is the
UI reference, not evidence of an inspectable implementation.

## Deployment shape and routing authority

Three deployment layers contain four independently enforceable destinations:

| Layer | Existing zone | Target | Intended use |
| --- | --- | --- | --- |
| Local | `local` | Qwen on the user's Mac | Private files, extraction, local actions, private final synthesis |
| Self-hosted | `hai` | HybridAI-operated GPU endpoints | More capable inference on approved HybridAI infrastructure |
| Managed / EU | `region` | HybridAI EU offers, including approved Mistral deployments | EU-constrained research and reasoning |
| Managed / global | `cloud` | HybridAI global offers, including OpenAI and Anthropic | Frontier work with explicitly eligible context |

This is a preference order, not a requirement to visit every destination. Model
capability/cost tiers remain separate from data location. A model's brand or API
compatibility does not prove residency. Endpoint identity, operator, processing
region, logging/retention path, and downstream fallback policy must be verified.
For this feature, “on this Mac” additionally requires the same device; existing
`local` terminology can also describe customer infrastructure.

**The local HybridClaw gateway owns policy, routing decisions, task state, and
dispatch.** A planning model proposes bounded subtasks and needed capabilities.
Qwen can plan with private input locally; a planner on HybridAI GPUs, EU, or
global infrastructure receives only context authorized for that destination.
The deterministic router selects an eligible model using capability, health,
budget, and policy. A local classifier provides evidence; neither it nor a
planning model can grant disclosure permission. No remote routing call sees
raw private input merely to decide where to send it.

## What can be reused

- [Zone and ladder resolver](../../../src/providers/model-routing.ts): already
  defines `local`, `hai`, `region`, `cloud` and supports maximum-zone filtering.
  The inspected [chat invocation](../../../src/gateway/gateway-chat-service.ts)
  passes `startTier` when rebuilding the ladder, so end-to-end enforcement must
  be established rather than inferred from the helper's interface.
- [Routing execution](../../../src/gateway/model-routing-execution.ts): retries
  and escalates failed attempts; avoids automatic retry after tool execution or
  a pending approval. It is not a resumable subtask handoff protocol.
- [Delegation](../../../src/gateway/gateway-service.ts) supports single,
  parallel, and chained jobs with model overrides. Final synthesis currently
  includes delegated result text. [Job persistence](../../../src/memory/delegation-jobs.ts)
  records status, but its stale-job handler fails interrupted jobs; checkpoint
  recovery and cancellation of running work need explicit implementation.
- [Confidential redaction](../../../src/security/confidential-runtime.ts) and
  [agent integration](../../../src/agent/agent.ts) provide optional rule-based
  masking and rehydration. [Approvals](../../../src/gateway/pending-approvals.ts),
  audit events, model discovery, and chat activity traces provide useful bases.

## 1. Establish the four destinations and optimized Mac inference

**Deliverable:** a managed native Mac inference service and verified endpoint
metadata for all four zones, usable independently before automatic handoffs.

- Resolve the exact local checkpoint first. The request names **Qwen 3.8 17B**;
  the supplied screenshot names **PPLX Qwen 3.8 27B**, and the verified
  [official Qwen card](https://huggingface.co/Qwen/Qwen3.8-27B) is 27B. Preserve
  the distinction between the requested 17B and the verified 27B; do not invent
  a model ID or silently substitute a checkpoint. Pin weights, tokenizer, template, license,
  quantization, and checksums once selected. PPLX post-training is a separate
  artifact and is not implied by using upstream Qwen.
- Use a persistent MLX-based native service as the proposed starting point,
  with an authenticated loopback API, streaming, validated tool calls, abort,
  health, and usage reporting. Add an accurately named backend registration;
  reuse the OpenAI-compatible transport without pretending the engine is vLLM.
  Keep Apple GPU inference outside Docker; provide a narrowly scoped local
  IPC/relay path for sandbox workers, with no public listening port.
- Optimize measured bottlenecks: keep weights resident, qualify 4/6-bit
  variants, preserve task-isolated prefix caches, bound prefill and context
  memory, and schedule local workers to avoid GPU/memory contention. Compare
  against pinned MLX-LM and llama.cpp baselines on the same checkpoint and Mac.
  Adopt custom Metal kernels or speculative decoding only after end-to-end
  quality and latency measurements justify them.
- Integrate download, start/stop, load/unload, sleep/wake, and crash recovery
  with the desktop lifecycle. Establish supported RAM/OS/chip combinations
  from measurements. Do not reuse Perplexity's performance numbers or assume
  its Qwen3.6-specific Lily engine supports Qwen3.8.
- Extend HybridAI discovery/transport with verified endpoint identity and zone
  propagation for GPU, EU, and global offers. The HybridAI backend must enforce
  the requested destination and prohibit an undisclosed upstream fallback;
  this is an external backend dependency, not a change this repo alone can prove.

**Code homes:** [local providers](../../../src/providers/local-openai-compat.ts),
[endpoint types](../../../src/providers/local-types.ts),
[HybridAI discovery](../../../src/providers/hybridai-discovery.ts),
[desktop lifecycle](../../../desktop/src/gateway-runtime.ts), and a new native
inference component with its own packaging and dependency artifacts.

**Exit criteria:** a pinned model completes representative multi-turn tool
tasks offline after installation; cancellation, memory pressure, and wake/restart
work; publish TTFT, prefill/decode rate, peak memory, and task correctness for
named hardware. Record numerical release budgets from that baseline. Each
configured destination reports verified identity and rejects forbidden fallback.

## 2. Enforce the privacy boundary before any data leaves

**Deliverable:** one mandatory egress policy for hybrid tasks, evaluated before
every outbound request and every release of protected context to another worker.

- Combine workspace/file labels, explicit user restrictions, tenant policy,
  existing confidential rules, and a local PII/sensitive-content detector.
  Restrictive labels survive extraction, summaries, artifacts, and memory.
  A classifier may tighten handling; it cannot relax a label. Explicit local
  restrictions apply even if the detector finds nothing.
- Carry effective permissions into normal chat, explicit model pins, each
  fallback/retry, delegated calls, tool loops, compaction, titles, embeddings,
  vision/OCR, RAG, memory processing, and final synthesis. Network tools, MCP,
  browser requests, channel delivery, telemetry, and artifact downloads are
  also disclosure paths. Include prompts, tool schemas/results, filenames,
  images, and error details in the boundary inventory.
- Enforce protected workers' network and file capabilities in the execution
  sandbox/egress broker. A provider wrapper alone cannot prevent shell or
  browser exfiltration. Where host execution cannot enforce the restriction,
  reject that protected execution mode. Do not label it local-only.
- Return allow, redact-and-allow, keep-local, request-consent, or deny. Bind
  consent to the exact outgoing payload digest, destination, purpose, and
  policy version; a change requires reevaluation. Tenant prohibitions cannot
  be overridden by a user click. Detector failure holds protected outbound
  work locally or pauses it; it never triggers remote fallback.
- Keep placeholder mappings on the Mac, scoped to task and destination. Store
  them locally with access controls if needed for restart recovery. Rehydrate
  only into authorized local tools and local user views. Sanitization creates
  a reviewed derivative, not an automatically public version of a private file.

**Code homes:** a new focused module under `src/security/`, the existing
confidential runtime, [provider routing](../../../container/src/providers/router.ts),
[auxiliary calls](../../../src/providers/auxiliary.ts),
[container execution](../../../src/infra/container-runner.ts), approvals, and
audit. Wire the existing ladder's zone inputs; enforce the policy again at the
actual request boundary so model pins and alternate paths cannot bypass it.

**Exit criteria:** transport-capture tests across all four destinations prove
that forbidden fixture content never arrives, including through tool output,
compaction, explicit pins, retries, screenshots, and final synthesis. Test
unknown endpoints, missing detector, injected instructions, stale consent, and
EU-provider fallback. Record counts, route identity, and protected digests in
audit events rather than raw confidential payloads.

## 3. Add resumable handoffs within one task

**Deliverable:** the user can start one task, run independent local and remote
subtasks, and continue it without restarting or exposing a private transcript.

- Extend existing delegation with a persisted task graph. A handoff contains
  task/parent IDs, objective, dependencies, approved input references, expected
  output, allowed destinations/tools, budget, policy version, and checkpoint.
  Build destination-specific context instead of copying the parent transcript.
- The planning model proposes the graph; the local gateway validates it and
  assigns execution. Default to the lowest qualified allowed destination.
  Existing observable failure triggers and task-specific validators justify
  escalation. Model self-assessment is only a proposal. Stronger remote
  reasoning may work on an approved abstraction while Qwen retains the source.
- Check both directions of every handoff. Local results may contain protected
  information even when the assigned question was public. Apply the gate before
  parent synthesis and before inserting a chain's previous result. The final
  artifact is assembled at a destination allowed to see all of its inputs,
  typically on the Mac for private work.
- Persist progress, approved derivatives, artifact versions, and committed
  tool actions. Resume from checkpoints after disconnect/crash. Use idempotency
  keys and reconciliation for uncertain external side effects; never replay a
  write merely because inference failed. Cancel running workers, propagate
  cancellation to descendants, and reject late results. Serialize conflicting
  file writes or merge reviewed patches against a known base version.
- Keep an active model's prompt prefix stable; each worker/destination gets its
  own context and cache. Preserve continuity through explicit task state, not
  assumed KV-cache portability. Existing A2A can later execute a whole worker on
  another host, but remote GPU inference does not itself require A2A deployment.

**Code homes:** extract focused orchestration modules from the delegation area
of `gateway-service.ts`; extend [delegation contracts](../../../src/types/side-effects.ts),
the job store, [routing execution](../../../src/gateway/model-routing-execution.ts),
and IPC. Preserve existing approval semantics at each tool boundary.

**Exit criteria:** one synthetic private-document task uses local processing,
an authorized GPU subtask, EU research, and an authorized global critique,
then produces a private local artifact. A companion local-only case makes no
remote disclosure. Both retain one task identity; crash/restart and cancellation
tests demonstrate no duplicate committed actions or private parent-context leaks.

## 4. Deliver visible parity and qualify the full workflow

**Deliverable:** desktop and web chat show the same task's workers and actual
data movement, using the supplied screenshot as the interaction reference.

- Add subtask cards with role, actual model, endpoint/zone, status, progress,
  stop action, tokens, latency, and cost. Add local CPU, memory pressure, and
  GPU metrics where supported. Label machine-wide metrics as such; report
  unavailable values honestly rather than attributing them to one worker.
- Add a compact destination control: Local / HybridAI GPUs / EU / Global, plus
  automatic model selection within the allowed set. Show why a handoff was
  chosen and the effective maximum disclosure boundary.
- Present exact disclosure previews and permitted choices: keep processing
  locally, approve the shown derivative/destination, or skip. Provide artifact
  previews and audit-backed statements such as “processed on this Mac” or
  “redacted context sent to EU.” Protect the UI transport too: a remote browser
  or Discord message is not the local screen.
- Stream versioned task/worker events through existing chat transport and replay
  them from durable state on reconnect. Keep private paths and content out of
  external monitoring. Resource sampling must not require arbitrary privileged
  shell commands during ordinary use.
- Qualify the release with the synthetic document workflow, real local model
  tool execution, and opt-in live HybridAI GPU/EU/global checks. Publish a parity
  matrix covering concurrency, consent, residency enforcement, offline behavior,
  resume, cancellation, observability, and final artifact correctness.

**Code homes:** [chat types](../../../console/src/api/chat-types.ts),
[chat stream](../../../console/src/routes/chat/use-chat-stream.ts),
[activity trace](../../../console/src/routes/chat/trace-block.tsx),
[model selector](../../../console/src/routes/chat/model-switch-select.tsx),
[approval card](../../../console/src/routes/chat/approval-card.tsx), and desktop
runtime metrics. Use the same authoritative events for UI and audit.

**Exit criteria:** the screenshot-style workflow is demonstrated end to end;
every model/location/privacy claim can be traced to execution and egress events;
reconnect reconstructs the cards; stop cancels real work. UI tests and full
boundary/recovery tests pass before claiming parity.

## Validation and scope

Implement in order: **destinations and inference → enforced boundaries →
resumable handoffs → observable product parity**. Keep hybrid execution limited
to development qualification until its boundary tests pass. No compatibility
aliases or speculative feature flags are proposed.

For implementation, run root typecheck/lint and targeted routing, provider,
confidential, delegation, approval, and job-store suites; container lint/build
and IPC tests for container changes; console tests/visual checks and desktop
tests for their surfaces. Add failure-mode and boundary coverage for all
high-risk changes. Packaging/dependency changes also require lockfile/shrinkwrap,
policy hashes, notices, and release checks under AGENTS.md.

The initial planning pass inspected source and upstream documentation. The
phase-1 implementation subsequently downloaded pinned models and ran isolated
Mac GPU tests. It did not restart the user's gateway or change their active
configuration. HybridAI deployment residency and downstream enforcement still
require backend implementation and live verification. The memory-aware setup
catalog follows the [current shortlist](local-model-shortlist.md), with Spark,
Bonsai, Qwen3.8 **27B** and Nex Mini as installation candidates. It does not
invent a 17B artifact or treat the post's performance claims as qualification.

Runtime references: [MLX-LM](https://github.com/ml-explore/mlx-lm),
[llama.cpp](https://github.com/ggml-org/llama.cpp), and
[Lily's published engine scope](https://github.com/perplexityai/pplx-garden/tree/main/lily).
