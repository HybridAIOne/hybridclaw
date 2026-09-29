# Three Laya checkpoints: matched routing evaluation

Same 200 authored prompts, 20 predeclared variants per checkpoint, FP16 MLX, and 80% selected-probability gate. 12,000 predictions in total: the existing 4,000 multilingual results plus 8,000 new English/typed-decisions predictions. No cloud inference, no live router changes. Checkpoint downloads were revision-pinned and weight hashes verified.

The dataset and variant definitions are identical across runs. This is reuse of an inspected dataset, not fresh validation. Checkpoint-specific temperatures remain unchanged; acceptance rates are not equivalently calibrated risk guarantees.

## Matched choice question: How difficult is this task?

| Checkpoint / state | Correct | EN /100 | DE /100 | Accepted | Correct among accepted |
|---|---:|---:|---:|---:|---:|
| Multilingual 322M / raw | 115/200 (57.5%) | 61% | 54% | 47/200 | 78.7% |
| Multilingual 322M / json | 128/200 (64.0%) | 68% | 60% | 69/200 | 79.7% |
| English 421M / raw | 114/200 (57.0%) | 61% | 53% | 0/200 | — |
| English 421M / json | 122/200 (61.0%) | 63% | 59% | 6/200 | 100.0% |
| Typed-decisions 421M / raw | 119/200 (59.5%) | 68% | 51% | 0/200 | — |
| Typed-decisions 421M / json | 129/200 (64.5%) | 67% | 62% | 0/200 | — |

## Best observed variant per type

Each maximum is selected on this same dataset. It is optimistic selection evidence, not a held-out accuracy claim.

| Checkpoint | Type | Variant | Correct | EN /100 | DE /100 | Accepted | Correct among accepted |
|---|---|---|---:|---:|---:|---:|---:|
| Multilingual 322M | choice | choice-json-difficulty | 128/200 (64.0%) | 68% | 60% | 69/200 | 79.7% |
| Multilingual 322M | score | score-json-capability | 112/200 (56.0%) | 60% | 52% | 103/200 | 66.0% |
| English 421M | choice | choice-json-capability | 133/200 (66.5%) | 65% | 68% | 7/200 | 100.0% |
| English 421M | score | score-json-difficulty | 130/200 (65.0%) | 67% | 63% | 55/200 | 96.4% |
| Typed-decisions 421M | choice | choice-json-capability | 137/200 (68.5%) | 73% | 64% | 0/200 | — |
| Typed-decisions 421M | score | score-json-difficulty | 129/200 (64.5%) | 72% | 57% | 0/200 | — |

## All matched variants

| Variant | Multilingual /200 | English /200 | Typed decisions /200 |
|---|---:|---:|---:|
| choice-raw-difficulty | 115 | 114 | 119 |
| choice-raw-category | 117 | 112 | 118 |
| choice-raw-capability | 116 | 116 | 126 |
| choice-json-difficulty | 128 | 122 | 129 |
| choice-json-category | 128 | 121 | 129 |
| choice-json-capability | 121 | 133 | 137 |
| choice-prefixed-difficulty | 114 | 116 | 132 |
| choice-prefixed-category | 115 | 110 | 122 |
| choice-prefixed-capability | 114 | 119 | 129 |
| score-raw-difficulty | 104 | 125 | 113 |
| score-raw-category | 104 | 124 | 119 |
| score-raw-capability | 106 | 120 | 115 |
| score-json-difficulty | 109 | 130 | 129 |
| score-json-category | 109 | 125 | 126 |
| score-json-capability | 112 | 130 | 128 |
| score-prefixed-difficulty | 107 | 125 | 118 |
| score-prefixed-category | 106 | 125 | 124 |
| score-prefixed-capability | 111 | 127 | 123 |
| choice-raw-neutral-labels | 111 | 118 | 126 |
| choice-raw-reversed-options | 107 | 108 | 115 |

## Provenance and limits

- Multilingual 322M: `aac6fef/laya-multilingual-mlx@ba40c87fcb357f1643d04d71323af9cdc3b9e591`; [design](laya-variations-2026-09-29/design.json), [report](laya-variations-2026-09-29/report.md), [per-call results](laya-variations-2026-09-29/results.jsonl).
- English 421M: `aac6fef/laya-mlx@20aed815fc6acde75733882e7ec0e3f28aeb9717`; [design](laya-english-2026-09-29/design.json), [report](laya-english-2026-09-29/report.md), [per-call results](laya-english-2026-09-29/results.jsonl).
- Typed-decisions 421M: `aac6fef/laya-typed-decisions-mlx@f9e501c2080cc57c13d6887820329758f5351125`; [design](laya-typed-decisions-2026-09-29/design.json), [report](laya-typed-decisions-2026-09-29/report.md), [per-call results](laya-typed-decisions-2026-09-29/results.jsonl).

- Raw choice and JSON choice are controlled comparisons. Score uses modal level; rounded expected-score diagnostics are in the per-checkpoint reports.
- Models are MLX conversions of the three upstream checkpoints. Port fidelity is not validated against PyTorch in this experiment.
- English and typed-decisions are English-oriented; the German subset intentionally measures language transfer.
- Direct inference latency excludes loading and differs from the earlier gateway timing. Checkpoints were run sequentially, not concurrently.
- Equal tier counts, partly paired bilingual cases and authored rubric labels limit generalization to real traffic and downstream model capability.
- Choosing a new checkpoint, state format or question requires fresh validation; no temperature or threshold tuning was performed.
