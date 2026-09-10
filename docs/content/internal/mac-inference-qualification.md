---
title: Mac Inference Qualification Record
description: Phase-1 measurements, tested boundaries and outstanding release qualification.
---

# Mac Inference Qualification Record

Initial qualification recorded 2026-09-09; this is a historical baseline.
The [2026-09-10 shortlist update](local-model-shortlist.md) replaces Qwen3 4B/8B
as setup candidates and adds the pinned Spark extension. The Qwen3 4B report
below does not qualify those new candidates. The implementation provides native MLX installation,
memory admission, desktop lifecycle, a scoped Docker relay, and the HybridAI
destination contract. It is an inference foundation, not complete hybrid-task
privacy or handoff parity. See the [setup guide](../guides/mac-local-models.md)
and [destination contract](hybridai-destination-contract.md).

## Spark agent-context check — 2026-09-10

The initial 8,192-token profile rejected a fresh PDF request before inference:
the normal agent instructions plus 43 core tool schemas tokenize to 30,519
tokens with the pinned Spark tokenizer. Clearing conversation history cannot
resolve this base-prompt mismatch.

The pinned Spark implementation uses nine full KV caches and 27 rotating
512-token caches. Admission accounts for the latter as a fixed allocation,
including one 256-token prefill chunk, rather than charging every layer for the
full context. It still reserves weights plus 10%, 1 GiB for working memory,
and both an active and a retained cache. Startup checks the lesser of current
available memory and the saved installation budget. Other artifacts retain
their existing context ceilings.

On an Apple M5 with 32 GiB, a temporary 40,960-token Spark profile passed the
streaming/tool-round-trip check and accepted the full 30,519-token agent prompt.
The response made a valid `read` tool call (89 output tokens). Peak MLX
allocation was 5,900,051,539 bytes, below the unchanged 7,119,945,728-byte
installation limit. This validates full-prompt admission and tool selection;
the complete PDF tool sequence was not exercised by this native API probe.
The test copied no prompts into this repository and used the existing pinned
weights with a separate authenticated test endpoint.

Validation: 61 targeted Vitest tests, five Python boundary tests, root typecheck,
lint, and root/container/console build passed. Boundary cases include an
unqualified artifact requesting larger context, malformed context values,
and an installed budget too small even when the current Mac has more capacity.
Full unit/e2e and remote-provider live suites were not run for this focused
memory-admission correction.

### Follow-up preparation diagnostic — 2026-09-10

A later gateway request used 114 tools and failed during preparation. The old
service collapsed all preparation exceptions into the same model/context
message. With the owner's approval, the configured MCP clients retrieved 71
tool schemas through discovery only; no MCP tools were invoked. A local
reconstruction using the recorded system/dynamic context, the same user
request, and the 43 core plus 71 MCP definitions measured:

| Catalog | Prompt tokens | Output reserve | Total | Installed limit |
| --- | ---: | ---: | ---: | ---: |
| 43 core tools | 29,679 | 2,048 | 31,727 | 40,960 |
| 114 core + MCP tools | 50,391 | 2,048 | 52,439 | 40,960 |

The added schemas contribute 20,712 tokens. The reconstructed full catalog
exceeds the installed context by 11,479 tokens before generation; a fresh chat
does not remove that overhead. These counts describe the reconstructed input,
not a captured original HTTP body, and do not qualify a larger context or a
successful PDF workflow. MCP descriptions and the recorded prompt stayed out
of the repository. The installed limits and runtime configuration were not
changed by this diagnosis.

The subsequent user-reported live error confirms 50,652 prompt tokens plus
2,048 output tokens against the 40,960-token limit, with 114 tools. The
reconstruction above uses a slightly different prepared message body.

A proposed fixed starter catalog (nine basic tools plus `tool_catalog`) measured
19,244 prompt tokens plus 2,048 output tokens, leaving 19,668 tokens within the
same limit. This is a tokenizer-only comparison of a proposed schema, not an
implemented or inference-tested workflow. See the
[local tool discovery proposal](local-tool-discovery-proposal.md).

The boundary preserves numeric context-overflow diagnostics (prompt, output
reserve, limit and tool count), separates Python memory failures, and redacts
all other library messages. Seven pure Python boundary tests pass, including
exact-limit admission, one-token overflow, and sensitive error-text rejection.
No context or memory limit is raised by this diagnostic change.

## Reproducible measurement

The [raw synthetic smoke report](mac-inference-smoke.json) was captured on an
Apple M5 with 32 GiB unified memory, Darwin 25.4.0, MLX-LM 0.31.3 and MLX 0.32.2.
The model was Qwen3 4B, MLX 4-bit, revision
`4dcb3d101c2a062e5c1d4bb173588c54ea6c4d25`, with 8,192 admitted context tokens.
The report includes a SHA-256 of the service implementation used for the run.

| Measurement | Observed |
| --- | --- |
| First output token, after service warm-up | 220 ms |
| Output tokens / elapsed | 71 / 1.705 s |
| Effective decode rate | 47.1 tokens/s |
| Effective prefill rate | 109.0 tokens/s |
| Peak MLX allocation during smoke | 2.43 GiB |
| Peak after boundary checks | 2.64 GiB |
| Streaming and two-turn function round trip | Passed |
| Cancel stream and complete a subsequent request | 1.10 s |

Rates include HTTP and request-processing overhead. The 24-token prompt is
too short to characterize sustained prefill throughput. This is one run on a
machine with other applications active, not a release SLO, a device-wide RSS
measurement or evidence of frontier-model task quality. Subsequent setup runs
measure their own result before activating a model.

Qwen3.8 27B revision `3e6447f082e89cc7f0bc6e5441afd38dfce760ff` was also
downloaded and manifest-verified, loaded, and exercised with a successful tool
round trip, cancellation, context rejection and recurrent prefix-cache reuse.
Those runs preceded the final wired-memory and cancellation refinements and
are not a qualified performance baseline for the final service. Current memory
admission selected the smaller fixture for the final run. Qwen3 8B has verified
artifact metadata and installation-time checks, but was not GPU-tested here.

For a configured, running service:

```bash
hybridclaw local benchmark
node inference/mlx/check_live.mjs ~/.hybridclaw/inference/mlx
```

Both use synthetic prompts. The latter also exercises contention and cancels
requests, so run it against an otherwise idle test installation. Benchmarking
does not restart a gateway or install another model.

## Boundary and failure coverage

The real GPU boundary run passed all twelve checks: authentication, browser
Origin rejection, model pinning, output budget, unsupported adapter rejection,
same-task prefix reuse, separate-task cache isolation, single-request admission,
stream cancellation/recovery, non-stream cancellation/recovery, oversized
context rejection, and health after the checks.

Targeted tests additionally cover memory estimates across 8–512 GiB, current
memory pressure, unsupported OS/architecture, installation locking, immutable
artifact manifests, tampering and extra files, remote-code rejection, endpoint
validation and discovered limits, config activation, destination binding and
acknowledgement, and desktop ownership across sleep/wake. The file-relay tests
exercise the real host/worker transport pair, including cancellation, symlink
input rejection and attempted model replacement. They do not launch Docker.

The native service retains a wired-memory budget, bounds context and caches,
uses 256-token prefill chunks and admits one request. Task namespaces switch on
the generator thread only after its previous batch drains; HTTP arrival cannot
relabel an in-flight recurrent cache. Cancellation wakes non-streaming response
queues as well as stopping GPU work. The installer activates endpoint, secret
reference and default model in one config write after checks pass.

Validation completed in this checkout: root typecheck and lint; container lint;
root/container/console build; 287 targeted root tests across the provider,
configuration, routing, gateway-status and IPC suites; 18 console tests; four
desktop lifecycle/setup tests; three Python boundary tests; and the twelve
real-GPU checks above. Both release checks and a package-content inspection
passed. Full unit/e2e suites, signed desktop packaging and credentialed remote
provider tests were not run; the focused suites cover the changed surfaces,
while the deployment qualification below remains open.

## Risk notes and limits

- The local OS account is trusted. Owner-readable files and authenticated
  loopback do not isolate a malicious process running as that same user.
- The Docker relay binds model, URL, credential and task on the host. A worker
  receives a random per-turn relay capability, not the loopback credential.
  IPC requests/responses have size and lifetime bounds; redirects are refused.
  The relay authorizes inference for that worker, not arbitrary network access.
- MLX serving disables registry access and remote model code; installation
  explicitly downloads pinned artifacts. Library upgrades need renewed tests
  because the wrapper relies on pinned MLX-LM generator APIs.
- Busy, unavailable, oversized and invalid requests fail locally. This does
  not override every existing gateway fallback, delegation or auxiliary path.
  Phase 2 must enforce a protected task's disclosure rules across those paths,
  tools, channels, memory and final synthesis before any local-only task claim.
- HybridAI destination acknowledgement binds a cooperating server's response;
  it does not prove residency, retention or downstream behavior. Contracts
  require backend enforcement. Legacy zone labels remain descriptive metadata.
  A response check cannot undo an outbound disclosure.

## Remaining release qualification

The phase-1 development foundation is available for testing. Its broader
release exit criteria still require: final-service 27B and 8B task suites;
physical 8/16/24/64+ GiB device coverage; long-running memory-pressure and real
sleep/wake tests; an actual Docker-to-Mac GPU run; representative multi-tool
tasks; comparable pinned llama.cpp and MLX baselines on the same checkpoint;
4-bit versus 6-bit quality/latency measurements; and numerical release budgets.
No custom Metal kernels or speculative decoding are claimed by this change.

Live HybridAI GPU, EU and global tests were not run: the backend needs to
implement the published contract first. Protected egress policy, resumable
handoffs and screenshot-style worker cards remain phases 2–4. The hardware
recommendation list is input for future qualification, not an automatic model
installation policy; advertised context and active MoE parameters alone do not
establish a usable memory budget.
