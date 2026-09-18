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

The fixed default starter catalog (nine basic tools plus `tool_catalog`) measured
19,244 prompt tokens plus 2,048 output tokens, leaving 19,668 tokens within the
same limit. The catalog is implemented and tested through real agent IPC and a synthetic
model HTTP endpoint. Native inference could not be rerun because the local
MLX endpoint was not listening; full PDF execution remains unqualified. See the
[local tool discovery design](local-tool-discovery-proposal.md).

Compact-catalog validation: 196 targeted unit tests and four integration tests
passed. The integration tests exercise real agent IPC and a synthetic model
HTTP endpoint, verify a 114-tool source catalog becomes ten model-facing
schemas, retain original call history, apply pooled-request overrides, preserve
cloud catalogs, block denied targets, preserve security hooks, and recheck
revoked tools during approval replay. Root typecheck/lint, container lint,
formatting, and the full build passed. No gateway or model restart was performed.

The boundary preserves numeric context-overflow diagnostics (prompt, output
reserve, limit and tool count), separates Python memory failures, and redacts
all other library messages. Seven pure Python boundary tests pass, including
exact-limit admission, one-token overflow, and sensitive error-text rejection.
No context or memory limit is raised by this diagnostic change.

## Two-schema Spark diagnosis (2026-09-10)

Native streaming replays used the installed Spark-X2.5 4B artifact and the
recorded PDF request, with credentials and prompt content retained locally.
These were model-response checks: returned tool calls were not executed.

- The original two-schema request (`skills_list`, `tool_catalog`) reproduced
  the generic inference error. Exposing `read` additionally returned a valid
  `read` call, while replacing the earlier tool summary alone still failed.
- The worker's final instruction naming its exact exposed schemas returned
  `tool_catalog` with `action=describe` and `name=read`, without a stream error
  (22.86 seconds in one run).
- A follow-up fixture containing the real `read` schema returned an empty
  completion. Further prompt-only experiments repeated discovery. The complete
  two-schema PDF workflow is therefore not qualified on this 4B model.

The implementation retains rejection of unexposed calls and invalid arguments;
it does not automatically rewrite them into catalog calls. Fixed generation
error categories distinguish unexposed tools, malformed arguments, and memory
failures without returning model or library payloads. Nine pure Python boundary
tests, 61 targeted unit tests, and five worker IPC/model-HTTP tests passed.
The IPC checks preserve schema and system-message stability within a turn and
verify full-mode behavior, permission restrictions, and approval replay.

### Missing-description recovery (2026-09-10)

The next live PDF turn completed `tool_catalog` list, then stopped on an unknown
tool lookup. A native continuation replay reproduced `action=describe` with
`name=pdf`: the model confused a skill name with a tool name. Returning a
corrective lookup error made it describe `read` next. Returning the standalone
`read` function schema then produced an unexposed direct call, which MLX rejected.

Catalog descriptions therefore show the actual `tool_catalog` invocation schema,
including the target name and its nested argument schema. Another native
continuation omitted the top-level `name` field from its catalog call. Missing
descriptions and missing call fields share a budget of two corrective results
per request. Invalid argument batches are recorded as blocked and no sibling
action executes. The catalog never executes an unknown target or echoes its
name in a lookup error. Attempts to call
unavailable tools, disabled discovery, and revoked approval targets remain
rejected. Native generation still rejects unexposed functions; no call rewriting
or runtime configuration change is part of this correction.

The final schema requires `name` on every catalog call (empty for general
listings). After a catalog-executed action, an append-only runtime reminder
repeats the exposed functions; previous messages and system/tool definitions
are unchanged. The reminder distinguishes tool names in skill instructions from the
functions exposed in the current request.

An isolated native worker then completed the original dog-joke PDF request with
only `skills_list` and `tool_catalog` exposed, using the installed Spark model
and recorded system/dynamic context. Its permitted underlying tools were limited
to `read`, `write`, `bash`, and `skills_list` to avoid external side effects; the
user's configuration and running gateway were not changed. The worker read the
bundled PDF skill and helpers and executed the bundled PDF generator. It
reported one PDF artifact after 125.54 seconds, with eight tool records including
two errors it recovered from. Text extraction confirmed the joke on one page,
and the rendered page was visually checked. This qualifies one native PDF workflow in the
isolated fixture, not general model reliability or the full configured MCP set.

Validation: 24 catalog unit tests, ten real worker IPC/model-HTTP tests, root
lint/typechecks, container lint, formatting, and the production build passed.
Tests cover bounded recovery, shared correction budgets, malformed batches
executing no siblings, missing name fields, filtered targets, disabled discovery,
security hooks, approval replay, full/direct-tool preservation, and exact
preservation of earlier messages and schemas. Full unit/e2e suites, Docker-to-Mac
GPU execution, and credentialed remote-provider tests were not rerun.

## Staged discovery qualification (2026-09-10)

The Hermes-inspired flow was exercised with the running Spark-X2.5 4B service
and a private temporary worker workspace. Only `skills_list` and `tool_catalog`
were exposed; the permitted underlying tools were `read`, `write`, `bash`, and
`skills_list`. The fixture retained the recorded system/dynamic context while
omitting the inline skill catalog and supplying one eligible PDF entry through
`skillCatalog`, representing compact skill discovery. It copied the bundled PDF
helpers and exposed no MCP credentials. The gateway and user configuration were
unchanged.

During iteration, one run completed skill search, exact-name selection, and
instruction reads but was rejected when the model emitted an unexposed function
(92.34 seconds, no artifact). Another emitted a malformed catalog call alongside
an exposed starter and stopped before executing anything (20.07 seconds). The
final code gives explicit deferred-shell syntax and permits bounded correction
for mixed batches only when every function is exposed. No sibling executes in
a malformed batch; unexposed functions are still rejected.

The final run completed in 85.34 seconds with nine tool records and one PDF.
The model searched skill summaries, selected `pdf`, read its SKILL.md, described
`bash`, and used the catalog to invoke the generator. It recovered from a
malformed catalog call and a misspelled script filename. Text extraction
confirmed the title and dog joke on one page, and the rendered page was checked.
This is one successful isolated run, not a reliability estimate or qualification
of the full configured MCP set.

Final validation: 79 unit tests and 14 real worker IPC/model-HTTP tests passed,
along with root lint/typechecks, container lint, formatting, and the production
build. Full unit/e2e suites, remote-provider/MCP execution, and Docker-to-Mac GPU
execution were not rerun for this focused discovery change.

## Reasoning-only completion regression (2026-09-10)

A current-build gateway session exposed another failure with only `skills_list`
starred and skills in Full mode. Its initial prompt contained about 18,000
tokens. The first turn took 134.6 seconds for one tool description and two
instruction reads. Its last model call consumed the entire 2,048-token output
budget in 82.3 seconds, with no generator call or PDF artifact. The shared
thinking parser supplied “Done.” for the otherwise empty answer, which was
persisted as completed. The follow-up spent 91.2 seconds repeating descriptions
and malformed catalog calls without creating the artifact.

The parser and Ollama adapter preserve empty visible output instead of creating
a completion claim. Local turns with no answer/tool call, or with a truncated
final response, report an explicit error and retain prior tool records. The
catalog guidance describes only unknown parameters; known read/shell calls
and already-loaded instructions can be used directly through the wrapper.
No model thinking setting, output budget, or operator star selection changes.

Validation: 122 targeted tests, root/container lint and typechecks, formatting,
and the production build passed. No new native inference qualification or full
MCP/Docker GPU run was performed for this correction.

Regression coverage exercises open and closed reasoning tags, both local
provider transports in streaming/non-streaming modes, preserved finish reasons
and usage, and real worker IPC. Synthetic reasoning-only completions cannot
produce a successful “Done.” turn; valid tool calls following reasoning still
execute through their normal checks. This does not establish improved native
model reliability or latency.

## Context-sized reasoning and skill state (2026-09-10)

The managed installation stored a 2,048-token generation cap independently of
its 40,960-token context. That field is removed: the native tokenizer computes
`min(requested output limit, installed context - exact prompt tokens)` before
prefill or generation. With no request limit, all remaining context is available.
The former failing call's 22,533-token prompt has 18,427 tokens available under
this rule. Setup's deliberately small qualification requests retain explicit
limits. Existing model weights and admitted context/memory budgets are unchanged.

A request-local guard cancels native generation on at least four exact reasoning
cycles spanning at least 256 tokens, checking periods up to 256 tokens every 16
tokens. It ignores normal/tool states and clears history at state boundaries.
Its fixed error contains no model output. This conservative guard does not
classify semantic or paraphrased repetition.

Native HTTP and sandbox IPC deadlines expire on inactivity. MLX uses SSE on the
wire for collected answers too, so long reasoning produces observable progress.
Transport storage remains bounded (64 MiB native response, 96 MiB base64 IPC),
allowing the admitted context to emit individual token frames. Cancelling the
consumer still cancels native generation; model/destination/auth checks remain
at the existing boundaries. Longer requests can occupy the single worker and
its admitted cache for longer, but cannot exceed the configured context or
memory allocation. No tool schemas, permissions, approvals, or prompt history
are changed by the generation guard.

The original full-skill prompt predates the operator's switch to starred skill
mode. A later recorded prompt, after the switch, contains zero inline skill
entries and the directory instruction. Tests explicitly exercise instance
starred mode with zero stars, mandatory skill behavior, and agent overrides.

Validation: 135 targeted Vitest tests, 18 Python tests, root/container lint and
typechecks, formatting, and the production build passed. The Python tests use
synthetic token streams, and transport tests simulate clock advancement; they
are not new GPU performance or end-to-end task-success measurements. The running
native service must be restarted to load the changed Python component. No
operator configuration or running process was changed during these checks.

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


## Review follow-up — 2026-09-10

- Config reload validates before updating the last-known-good snapshot. Invalid
  MLX URLs and zones use the same failure class as other endpoint failures.
  Incremental writes remain blocked against invalid disk settings; validated
  full Admin saves and snapshot restoration repair them. Six refresh guards
  share one implementation. Recovery tests preserve the invalid file until a
  valid replacement is supplied.
- Full setup status runs bounded VM/uv probes asynchronously. A lightweight,
  equally authorized activity view supplies 2.5-second polling; capacity and
  prerequisite refreshes run every 30 seconds. Failed polling marks cached
  data and disables controls. Desktop startup uses the same local eligibility
  condition as its Labs menu.
- Fixed native lifecycle error codes distinguish memory, context, timeout,
  artifact and provider-name failures. Structured logs keep only these safe
  diagnostics or allowlisted OS error codes, never raw library/subprocess data.
- The per-action catalog reminder used by the earlier native qualification is
  removed. Initial guidance, concrete argument validation, approval boundaries,
  immutable prior messages and persisted tool exchanges remain covered by IPC
  tests. This change has not been requalified on a live model.
- Reasoning periodicity checks use a bounded linear Z scan. Synthetic tests
  compare the exact stopping token with the previous rule. Three 32,768-token
  CPU benchmarks (unique, random and repetitive-with-progress streams; three
  repetitions each) measured about 2.2–5.6 times faster guard processing. These
  measurements are not end-to-end GPU throughput claims.
- HybridAI transports pass expected destination headers separately from the
  assembled request. Missing, partial or mismatched request contracts fail
  before fetch; successful responses still require acknowledgement. Ordinary
  offers without an advertised contract remain usable. This is protocol
  enforcement, not evidence of an operator's physical data residency.

Small two-site formatting/wrapper duplication and the desktop/gateway platform
predicate remain local to their packages, consistent with the repository's
rule-of-three guidance. Tool-specific read/bash/skills examples are intentional
model guidance; no generic abstraction or extra runtime policy was introduced.
