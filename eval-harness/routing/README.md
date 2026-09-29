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

## Laya type/state/question ablation

[Twenty-variant report](results/laya-variations-2026-09-29/report.md) and
[exact experiment design](results/laya-variations-2026-09-29/design.json).

The same 200 cases were evaluated with `choice` and ordinal `score`, three
state formats (raw text, `{"task": text}`, and a prose prefix), and three question
wordings. Additional controls replaced choice keys with A/B/C/D or reversed
option order. All 20 variants were specified before inference: 4,000 local
predictions, no cloud calls. Score was decoded by modal level, with rounded
expected score reported separately. Noul is a yes/no proposition interface,
not a direct four-tier selection primitive, and was not tested here.

Choice with JSON state reached 128/200 (64%), versus 115/200 (57.5%) for the
current raw-state choice. Best ordinal score reached 112/200 (56%). The JSON
state/difficulty question accepted 69 decisions, of which 55 were correct;
14 confident errors remain. This is exploratory reuse of the existing corpus,
not fresh validation. No production prompt/type/state change was made.

Repeat locally after setup:

```bash
HF_HUB_OFFLINE=1 ~/.hybridclaw/laya/venv/bin/python eval-harness/routing/laya-variations.py \
  --model ~/.hybridclaw/laya/model \
  --checkpoint aac6fef/laya-multilingual-mlx@ba40c87fcb357f1643d04d71323af9cdc3b9e591 \
  --baseline eval-harness/routing/results/2026-09-29T17-32-52.218Z/metadata.json \
  --output /tmp/laya-variations-new-run
```

The output directory must not exist. Results include every variant, not only
winners. Confidence is the chosen option/level probability; no entropy gate,
probability rescaling, or threshold tuning is applied.

## Three-checkpoint comparison

[Matched comparison and all variants](results/laya-checkpoints-report.md).
The English and typed-decisions MLX checkpoints were downloaded to a temporary
cache at pinned revisions and their weights verified against Hub LFS SHA-256
metadata. The installed multilingual checkpoint and live router were unchanged.
The same 20 variants were run on both additional models, producing 8,000 new
predictions and 12,000 total across the three checkpoints. Checkpoint-specific
calibration temperatures were retained.

With the identical difficulty question, JSON state scored 64% for multilingual,
61% for English, and 64.5% for typed-decisions. Best observed choice variants
reached 64%, 66.5% and 68.5% respectively. These maxima are exploratory selection
on the same corpus; none approaches the earlier JEV/Gemma 91.5% rubric match.
The best English choice accepted only 7/200 at 0.8; the best typed-decisions
choice accepted none. English score was more useful than multilingual score:
its best variant matched 130/200, accepting 55 decisions with 53 correct.
Fresh validation would be needed before selecting that variant for deployment.

To reproduce, use the same `laya-variations.py` command with each downloaded
model directory and its `--checkpoint repository@revision` from the saved design.
The runner records weight SHA-256, runtime version and model configuration. Run
`python3 eval-harness/routing/compare-laya-checkpoints.py` to regenerate the
combined report from the three saved result directories. No new model calls
are made by the report generator.
