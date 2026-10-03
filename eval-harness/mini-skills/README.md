# Dense skill cards: Bahn experiment

`mini: true` publishes a complete bounded SKILL.md body in the prompt and in
`skills_list` search/selection results. The bundled Bahn card uses three dense
lines: a parameterized URL, an evidence/error rule, and UI fallback advice.
It adds no executable tool or service integration to core.

## Reproduce

Use Node 22, installed root/container dependencies, browser binaries, stored
HybridAI credentials, and an authenticated running gateway. Record
`hybridclaw gateway status` and first run this query in a fresh gateway session:

```text
Suche mal zugverbindungen München - Köln für morgen vormittag
```

Point `BENCH_AUDIT` at that session's private `data/audit/<session>/wire.jsonl`.
It must contain an `agent.start` event with the complete system prompt and
dynamic context. Run from the checkout:

```bash
export BENCH_AUDIT=/absolute/path/to/baseline/wire.jsonl
export BENCH_AGENT_ID=your-agent-id
export BENCH_BROWSER=local
node --import tsx eval-harness/mini-skills/benchmark.mjs baseline 2
node --import tsx eval-harness/mini-skills/benchmark.mjs normal 2
node --import tsx eval-harness/mini-skills/benchmark.mjs mini 2
```

Optional `BENCH_MODEL` overrides the captured model; otherwise it is preserved.
`BENCH_BROWSER` defaults to the configured provider; `GATEWAY_URL`,
`AGENT_BROWSER_BIN`, `AGENT_BROWSER_EXECUTABLE_PATH`, and
`PLAYWRIGHT_BROWSERS_PATH` support the existing browser/runtime setup.
The harness reads secrets in memory, spawns a fresh checkout-local worker and
workspace per run, and uses authenticated stdin IPC. It never restarts or
reconfigures the gateway. Local browser sessions close after each run.

All runs retain the captured prompt/context and the same provider, model and
MCP configuration. `baseline` adds no card; `normal` adds its metadata and a
readable file; `mini` preloads the complete body. The experimental directory
contains only that card, so these are routing comparisons, not full production
workspace replays. Other captured skill metadata is retained in the prompt.
The experimental skill bypasses admission only in this unshipped harness;
scanner/channel/disabled-skill eligibility is covered by integration tests.
Normal tool approvals remain active. Run variants serially to avoid contention.

JSON lines contain latency, tool timings, API tokens, answers, hashes, and a
private temporary evidence path. Keep full audit prompts and worker outputs
outside Git. Inspect the saved tool results to judge route, requested local
date/time, submitted search, and source-backed connections. Worker
`status: success` means an answer was produced, not that the journey lookup
succeeded. Short honest failures still fail timetable retrieval.

## Results, 2026-10-03

The baseline was recorded before implementation: two gateway runs took 18.0
and 30.9 seconds, with three and four calls; neither returned verified trains.
The running gateway used HybridAI GPT-6 Luna and mac-cua. That browser returned
an empty “Startseite” without a URL even after homepage navigation. Local
browser launches inside the coding sandbox also crashed. These results do not
establish a DB-site failure and are excluded from the working-browser table.

Fresh isolated workers outside the sandbox used the same captured prompt and
GPT-6 Luna, with `browserProvider=local`. Two repeats per variant:

| Guidance | Wall time | Tool calls | Model responses | Verified journeys |
| --- | --- | --- | --- | --- |
| Baseline | 34.3 / 104.2 s | 6 / 27 | 7 / 28 | 0 / 2 |
| Ordinary skill, final text | 23.1 / 16.4 s | 5 / 2 | 6 / 3 | 0 / 2 |
| Mini-card, final text | 15.1 / 17.9 s | 1 / 1 | 2 / 2 | 0 / 2 |

An initial form-only card took 121.7 seconds and 29 calls without submitting
the correct search. Explicit advice to discover `browser_click` instead of
tabbing took 83.3 / 78.0 seconds and 17 / 18 calls. One run submitted the
requested route and date but received DB access-error 751. The retained
prefilled booking link eliminated web searches and form entry in both runs;
both observed 751 and reported that no timetable could be verified.

The deep link was also checked in a fresh Playwright browser. The booking URL
populated route/date state, then returned 751; placing the same hash on the
homepage did not populate the form and was discarded. No hardcoded station
IDs, dates or element refs are retained in the card. The fallback uses fresh
refs and the existing tool catalog to reach deferred clicks.

This demonstrates shorter routing to an observed failure, not a successful
end-to-end speedup. Two runs have substantial baseline variance, and neither
cards nor ordinary skills overcome the observed source access restriction.
`results.json` records sanitized measurements and manual correctness labels.
