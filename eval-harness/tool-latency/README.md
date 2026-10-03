# Tool lookup latency checks

Use fresh conversations and real connector data for both prompts:

- `Welche Proteinriegel im dm haben den höchsten Proteingehalt absolut in g?`
- `Welche Aktionen gibt es gerade bei dm?`

Run the checkout-local worker through authenticated IPC with the same provider,
model, workspace prompt and MCP configuration as the running gateway. Repeat
fresh histories in one worker to distinguish connection startup from warm turns.
Use the gateway's streamed `/api/chat` tool events for an end-to-end comparison.
Do not restart the gateway or change its configured model for these checks.

After building the checkout, run
`node eval-harness/tool-latency/benchmark.mjs 10 > results.jsonl`
against the authenticated local gateway. It reads the stored API token in memory,
runs both prompts serially with fresh sessions and prints JSON lines containing
total latency, model response count, tool counts/timings, prompt tokens and the
answer for manual correctness assessment. Ten runs per prompt is the default;
one to 100 runs may be requested. Initial summaries include p50/p90 for all
answers but leave pass rate unset until correctness has been reviewed.
Set `BENCH_AGENT_ID` to choose the agent. `GATEWAY_URL`, `GATEWAY_API_TOKEN` and
`BENCH_MODEL` are optional overrides. Record `hybridclaw gateway status` before
each comparison so results are associated with the actual running build.

Review every sample against the retrieved evidence and set its `correct` field
to `true` or `false` in the saved JSON lines. For protein, check the highest
grams **per bar**, including unit conversions and the ordering of all compared
candidates; merely mentioning 27 g is insufficient. For promotions, require a
source-backed overview of the current relevant offers, with their applicable
dates and conditions. A refusal, a product list, or an unsupported partial
answer fails. These are human verdicts; the harness does not pretend that text
matching establishes factual correctness or current coverage.

Run `node eval-harness/tool-latency/report.mjs results.jsonl` after grading.
It reports all-run p50/p90, correct-answer latency and the fraction of **all**
runs that are correct and below ten seconds. It exits nonzero for missing
verdicts, failures or fewer than ten samples per prompt/worker-state group.
Incorrect fast runs remain in the denominator and in all-run latency statistics.

Fresh sessions do not prove cold worker state. By default runs are labeled
`unknown`. Set `BENCH_WORKER_STATE=cold` or `warm` only when runtime logs verify
the state for every measured turn; reports keep these groups separate. The
harness does not evict workers or restart the gateway to create cold runs.

Record wall time, model response count and duration, individual tool durations,
overlap, prompt tokens and answer correctness. Audit events flushed at turn end
are not reliable tool start timestamps. A fast wrong answer cannot pass the
graded report; an ungraded answer has no pass verdict.
File references in worker output are IPC transport; inspect the saved result or
restore it on the gateway before measuring result size or checking evidence.

## Observations, 2026-10-03

The first inline-schema patch's gateway rerun took 17.1 seconds and five model
responses, including a correction because catalog listing required `name`.
Isolated worker repeats took 11.9–18.1 seconds. Connector reads themselves took
roughly 0.4–0.9 seconds each; model round trips dominated.

With complete tool results, compact discovery and prompt formatting, five
isolated repeats took 9.3–11.8 seconds and returned the correct 27 g winner.
Three used three model responses; two used four. This approaches the target
but does not establish a consistent 5–10 second guarantee. More aggressive
skill-description shortening produced incorrect rankings and was discarded.
A separate two-search probe confirmed live concurrent dm reads (0.48 and
0.52 seconds), with a 6.2-second complete turn.

Promotions are outside the discovered dm connector's product/store scope.
The page returned HTTP 200 with an empty app shell and a reCAPTCHA script,
which incorrectly triggered `bot_blocked`. Visible-text classification fixes
that hint. Successful browser runs with the shorter prompt took 17.9–25.4
seconds; browser navigation took 4.0–7.4 seconds. This query needs further
optimization before meeting the latency target. These runs preceded removal
of the per-result preview cap and the final conservative prompt formatting.

## Follow-up checks

The merged build was also tested through the actual gateway: the protein query
took 18.2 seconds and four model responses. Its answer ranked 23 g above the
27 g candidate despite receiving the evidence, so it failed the correctness
check. The promotions query took 26.8 seconds, including repeated searches and
an auxiliary extraction of a 404 page.

Exposing complete small, reviewed read definitions directly removed catalog
listing in three fresh isolated protein runs. They took 10.3–11.9 seconds and
three model responses, but only two returned a consistent correct ranking.
The equivalent promotions runs took 5.7–29.9 seconds; only the 29.9-second run
retrieved the official page and answered the question. Fast refusals and
unsupported rankings do not count as performance improvements.
These small samples describe individual observations, not a reliable latency
distribution: protein correctness was two of three runs and promotions
completeness was one of three. The 29.9-second success cannot stand in for all
promotions runs.

A subsequent repeat through the live merged gateway returned the correct
protein answer in 9.8 seconds. Its promotions answer took 6.3 seconds but
did not retrieve or summarize the offers, so it failed the quality check.
The live gateway remained on the merged build; these measurements do not
establish the follow-up change's effect or consistent sub-ten-second answers.

Additional numerical prompt guidance, more aggressive skill summaries, multiline result
formatting, table expansion and DOM-based browser readiness did not establish
a reliable improvement and were discarded. The retained changes preserve full
tool results and the existing browser network-readiness wait. The browser tool
description is shorter, and fetch escalation supplies an explicit next call.
No running gateway or configured model was changed for these experiments.

Consistent sub-ten-second performance remains unproven. Further work needs to
address source coverage and numerical evidence, not merely remove runtime
waits: the dm connector has no promotions endpoint, and the model sometimes
misranks the compact nutrition data. Several connector calls also took about
25 seconds, independently of model response time.
