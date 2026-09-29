# Three-router evaluation

200 unique synthetic prompts, balanced across four capability tiers and two
languages (25 per tier/language). The corpus uses aggregate themes from a
read-only inspection of 1,500 recent local user-message rows: writing,
translation, coding, model operations, documents and planning. No session text,
identities, addresses, secrets or real business facts are copied into the dataset.
Specialist advanced prompts broaden coverage beyond the observed history themes.

Labels were authored before calling any model and use the shared routing rubric:

- Basic: trivial arithmetic, greetings and simple facts.
- Economy: everyday writing, translation and summarization.
- General: programming, debugging and multi-step analysis.
- Advanced: specialist reasoning, proofs and complex system design.

This is rubric classification, not a measurement of which answering model can
actually solve a task. Balanced class prevalence and some bilingual semantic
counterparts mean the 200 cases are not independent samples of real traffic.
There is no independent human adjudication of the labels.

## Run

Requires a source checkout, installed Laya environment, configured JEV key and
the configured Gemma endpoint. Credentials are read by the existing production
provider code, never copied into result files. The run makes paid remote calls.
Only run with authorization to submit this synthetic dataset to those providers.

```bash
node --import tsx eval-harness/routing/run.mjs --smoke
node --import tsx eval-harness/routing/run.mjs
python3 eval-harness/routing/report.py eval-harness/routing/results/<run-directory>
```

The runner uses `classifyRouting`, the checkout's Laya worker, and the current
four-tier configuration. It neither restarts the live gateway nor changes its
settings. The separate local worker is stopped on completion. It preserves the
configured confidence threshold and timeout; remote failures are results, not
silently retried. JEV/Laya receive the same typed question; Gemma receives the
production chat-classifier instructions for the same rubric. Gemma emits no
confidence score. Startup is excluded, first inference is included, and calls
are concurrent across engines but sequential per engine.

Saved metadata includes the question, rubric, dataset hash, commit, model IDs,
threshold and timeout. JSONL checkpoints retain partial results on interruption.
The report distinguishes raw decisions, accepted decisions, and outcomes after
configured-default fallback. Do not interpret missing prices as free usage.

## Recorded comparison (2026-09-29)

[Full report](results/2026-09-29T17-32-52.218Z/report.md),
[per-call evidence](results/2026-09-29T17-32-52.218Z/results.jsonl), and
[run metadata](results/2026-09-29T17-32-52.218Z/metadata.json).

- JEV 1.13.0: 183/200 labels matched, 251 ms median; accepted 167 decisions,
  of which 164 matched. One invalid response is retained as a failure.
- Laya multilingual 322M, corrected probability gate: 115/200 matched,
  16 ms median; accepted 47 decisions, of which 37 matched.
- Gemma 4 E4B IT: 183/200 matched, 264 ms median; no confidence abstention.
  Most errors sent German Basic tasks to Economy.

A post-hoc replay using JEV above its threshold and Gemma otherwise matches
195/200 labels, requiring 33 Gemma calls. Laya with Gemma fallback matches
180/200. These are simulations, not live serial-fallback latency measurements
or independently validated new policies. The current Laya checkpoint is not a
reliable replacement for either remote router on this corpus.
