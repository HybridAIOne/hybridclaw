# Turn latency profile

`profile.mjs` is the lap timer. It reads what the gateway already records and
prints where the wall time of a turn goes, so a change can be measured before
and after without a live benchmark:

```bash
node eval-harness/turn-latency/profile.mjs --days 14 --source gateway.chat
```

Inputs, all under `HYBRIDCLAW_DATA_DIR` (default `~/.hybridclaw/data`):

- `audit/<session>/wire.jsonl` — `turn.start`, `agent.start`, `model.usage`
  (with `performanceSamples` per model call), `tool.call`, `tool.result`,
  `turn.end`.
- `gateway/model-responses.log` — `cached_tokens` per call, joined to the
  samples by provider, prompt and completion token counts. Needs
  `debugModelResponses` on the gateway.
- `last_prompt.jsonl` — the last request body, for the prompt composition.

Sections:

- **Turns** per source: wall p50/p90, model calls per turn, the gateway's time
  before the agent starts and after it ends.
- **Model calls** per provider and model: duration, time to first text delta,
  prompt and output tokens, uncached tokens, the tail after the first delta,
  and a least-squares fit `call_ms ≈ floor + a·promptK + b·outTokens`. Use the
  fit to turn a prompt-size change into seconds; trust it only inside the
  prompt-size range the data covers.
- **Round trips the harness could avoid**: discovery calls, two-step skill
  loads, tool errors.
- **Tool durations**, **system prompt sections** and the **latest request
  body** split into system, history and tools.

The script is read-only and never contacts the gateway or a provider. Audit
timestamps are flushed at turn end, so tool start times are not reliable;
use `tool-latency/` for live, end-to-end runs.

## Findings, 2026-10-12

Measured on one install over 14–30 days of mostly web and scheduler traffic on
`hybridai/gpt-6-luna`.

| Measure | Value |
| --- | --- |
| Chat turn wall time | p50 12.9 s, p90 54 s |
| Single-call chat turn | p50 5.7 s |
| Model calls per chat turn | half the turns make 2 or more |
| One model call | p50 3.3 s, p90 5.8 s |
| Time to first text delta | p50 2.6 s |
| Cache hit on the prompt | 91% of calls; uncached p50 ≈ 700 tokens |
| Prompt per call | p50 ≈ 42K tokens: system ≈ 65K chars, 83 tools ≈ 59K chars |
| Gateway before the agent starts | p50 ≈ 0.35 s, p90 ≈ 1 s |
| Gateway after the agent ends | p50 ≈ 0.15–0.2 s |
| Discovery calls | 17% of model calls (`skills_list`, `tool_catalog`, `list_connectors`) |
| Tool errors | 8% of tool calls, each one a further round trip |

Model calls are nearly all of the wall time. Cached prompt tokens are not
free: with the uncached share held small, a call over a 25–35K-token prompt
took p50 2.4 s, over 35–45K 3.4 s and over 45–60K 5.1 s. The fit is roughly
65 ms per 1K prompt tokens plus 6.5 ms per output token. Prompt size and turn
depth are correlated, so treat the slope as an upper bound.

Ranked levers, biggest expected win first:

1. **Fewer round trips.** Every avoided model call saves about 3.5 s.
   - `skills_list` search → `skills_list {name}` → `read` takes three hops to
     load one skill. The search result can point at `read` directly.
   - Inline more deferred tool schemas so a call needs no `describe` hop.
   - Return recoverable argument errors as clamps or hints in the same
     result where that is safe (for example a `limit` above 100).
2. **A smaller per-call prompt.** At about 65 ms per 1K tokens, 10K fewer
   tokens saves about 0.65 s on every call.
   - `<available_skills>` is the largest system section at about 28K chars.
   - The 19 `browser_*` schemas are about 13K chars and most chat turns never
     use them.
   - MCP results append `structuredContent` as pretty-printed JSON after the
     text blocks, which usually already carry the same data.
3. **Start a tool when its call is complete in the stream**, not after the
   whole response. Every provider buffers tool calls to the end today.
4. **Keep connections warm.** No undici dispatcher is configured, so an idle
   socket closes after 4 s. TLS setup to the relay measured 70–110 ms, paid
   again after any tool or think time over 4 s. Preconnect during worker start.
5. **Take bookkeeping off the critical path.**
   - Re-listing MCP tools older than 60 s is awaited before every request, so
     most chat turns on a warm worker pay for it. Re-list in the background.
   - The end-of-turn artifact scan walks the whole workspace on every turn,
     with or without tools: 7.9K files took 56 ms warm and 0.5 s cold. Scan
     only when a reply or tool result names a file.
6. **Cold workers.** The worker exits after 5 minutes idle, so the next turn
   starts cold. A compile cache and probing runtime tools while stdin is
   pending shorten that start.

Not yet measured: the gateway's context build stage by stage. The figures
above put it at about 0.35 s before the agent and 0.2 s after it.
