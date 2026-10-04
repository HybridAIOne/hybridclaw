# Mini-skill evaluation

The reusable format, authoring checklist, and correctness rubric live in
[Authoring Mini-skills](../../docs/content/extensibility/mini-skills.md).

`mini: true` publishes a complete bounded SKILL.md body in the prompt and in
`skills_list` search/selection results. The bundled Bahn card uses three dense
lines: a parameterized URL, an evidence/error rule, and UI fallback advice.
It adds no executable tool or service integration to core.

## Reproduce

Use Node 22, installed root/container dependencies, browser binaries, and stored
credentials for each requested provider. Record `hybridclaw gateway status`.
A running gateway is needed for gateway-dependent tools; local browser reads
can run in isolated workers while it is stopped. Capture the baseline before
the tested card is installed or loaded; a baseline already containing the card
is contaminated. First run this query in a fresh gateway session:

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
The production provider resolver loads that model's credentials and request
headers; it never changes the configured default. Native Anthropic and
configured local providers can be selected as well as HybridAI.
`BENCH_SKILL` selects a bundled `skills/<name>/SKILL.md` (default `bahn`).
Its directory/name must match and its complete body must qualify as a mini card.
`BENCH_PROMPT` overrides the task (default is the query above); set it for
other sites and use an explicit future local date for repeatable DB inputs.
`BENCH_BROWSER` defaults to the configured provider; `GATEWAY_URL`,
`AGENT_BROWSER_BIN`, `AGENT_BROWSER_EXECUTABLE_PATH`, and
`PLAYWRIGHT_BROWSERS_PATH` support the existing browser/runtime setup.
The harness reads secrets in memory, spawns a fresh checkout-local worker and
workspace per run, and uses authenticated stdin IPC. It never restarts or
reconfigures the gateway. Local browser sessions close after each run.

All variants retain the captured prompt/context and MCP configuration; within
each model comparison, keep provider/model/browser fixed. `baseline` adds no
card; `normal` adds its metadata and a
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
Each trial has a four-minute deadline. A timeout is emitted as
`status: timeout` with no completed answer; worker exits are explicit errors.
Both remain failed trials and subsequent repeats continue. Missing token/tool
metrics are unknown, not zero.

## Cross-model smoke test

Verify exact model IDs in the configured provider catalogs first. The IDs
confirmed on 2026-10-04 were `hybridai/Qwen/Qwen3.6-27B-FP8`,
`hybridai/gpt-6-luna`, and native `anthropic/claude-sonnet-5-5`.
Sonnet 5.5 was absent from the HybridAI catalog; do not substitute Sonnet 5.
The providers document [Qwen 3.6 27B](https://huggingface.co/Qwen/Qwen3.6-27B),
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), and
[Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5).
Catalog availability is account-specific and should be rechecked.

With the baseline and browser environment above, run serially:

```bash
export BENCH_SKILL=bahn
export BENCH_PROMPT='Suche Zugverbindungen München Hbf nach Köln Hbf am 2026-10-05 ab 09:00, mit Abfahrt, Ankunft, Umstiegen und angezeigten Preisen. Nicht buchen.'
export HYBRIDCLAW_DISABLE_CONFIG_WATCHER=1
for model in hybridai/Qwen/Qwen3.6-27B-FP8 hybridai/gpt-6-luna anthropic/claude-sonnet-5-5; do
  for variant in baseline normal mini; do
    BENCH_MODEL="$model" node --import tsx eval-harness/mini-skills/benchmark.mjs "$variant" 2
  done
done > /private/tmp/mini-skills-matrix.jsonl
```

Update the date when rerunning. These 18 live runs are a smoke test, not a
robust ranking. Rotate variant order for a larger evaluation, score every
saved trace using the guide's rubric, and distinguish verified retrieval,
honest site failure, provider/tool failure, and timeout. Missing gateway tools
are infrastructure failures, not model errors. Do not infer successful
retrieval from answer text alone. Raw JSONL includes answers and private
evidence paths; sanitize it before committing a report.

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

## Results, 2026-10-04: three-model smoke test

Eighteen trials attempted the same explicit request: München Hbf → Köln Hbf,
2026-10-05, departure from 09:00, with shown times, changes, and fares; no
booking. Each model/variant had two fresh workers and browser sessions.
The 540-unit card, captured prompt/context, browser backend, and MCP setup
were fixed. 15 trials produced answers and 3 timed out.
The configured gateway was unreachable; local browser tools still worked.
Two initial probes with an obsolete browser-binary path were excluded before
the working-browser trials. The harness now uses the installed root binary
and rejects a missing binary before starting a worker.

Entries show **wall seconds / tool calls**, in repeat order. `timeout` means
the four-minute deadline was reached; its tool/token counts are unknown.

| Model | Baseline | Ordinary card | Mini card |
| --- | --- | --- | --- |
| GPT-6 Luna (HybridAI) | 148.8 s / 33; 86.8 s / 17 | 20.3 s / 3; 15.2 s / 2 | 12.6 s / 1; 15.1 s / 1 |
| Qwen 3.6 27B FP8 (HybridAI) | timeout; timeout | 25.4 s / 2; 25.8 s / 2 | 32.4 s / 1; timeout |
| Sonnet 5.5 (native Anthropic) | 42.0 s / 6; 35.1 s / 4 | 14.8 s / 3; 17.3 s / 3 | 15.8 s / 1; 14.9 s / 1 |

All eleven completed guided trials constructed the requested route/date/time
URL, observed DB access-error 751, and stopped without inventing timetables.
The remaining guided trial, Qwen mini repeat 2, timed out without a retained
tool trace. This is an incomplete attempt, not evidence that it followed or
ignored the card. No variant returned verified journeys for the request.

Luna's unguided trials spent 17/33 calls on discovery, web search, and form
interaction, and could not verify the requested date. Sonnet's unguided
trials used 4/6 calls, encountered DB access errors, and consulted other
sources; one also observed a 503 from a public timetable API. Neither
verified the requested timetable. Qwen's unguided outcomes are retained in
the measurements rather than dropped from the comparison.

Completed mini trials used one browser call. Ordinary cards added file
loading/discovery calls; Sonnet's wall times overlapped despite fewer calls
inline. Qwen's timeout occurred with and without a card, so this experiment
cannot attribute it specifically to compression. Some failure answers added
unverified recovery advice (for example, asserting that another retry often
works) or unsuitable alternative-source suggestions. The no-fabricated-
timetable assessment does not certify every sentence of those answers.

This is evidence about direct routing and stopping at an observed failure.
It does not validate successful results, blank-page fallback, unrelated
requests, relative-date handling, or guarded-action behavior. Use successful
live pages and separately labeled controlled fixtures, several tasks, more
repeats, and rotated variant order before selecting a model or claiming a
format-wide speedup. Provider wrappers differ across this matrix. The
experimental workspace contains only the tested card; retained metadata for
other captured skills can cause file/discovery failures, as observed in one
Sonnet baseline trial. These are routing comparisons, not full production
workspace replays.

Sanitized per-run metrics and assessments are in
[`results-2026-10-04.json`](results-2026-10-04.json). Private prompts, browser
profiles, raw answers, error IDs, and evidence paths are excluded.
