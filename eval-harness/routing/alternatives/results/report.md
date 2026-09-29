# Small local routing models — 2026-09-29

Development: the existing 200 prompts. Holdout: 120 newly authored prompts, balanced across four tiers and English/German. All selections were fixed using development results before held-out inference. These are authored rubric labels, not measured ability of downstream execution models.

Horizon matches the best Laya checkpoint on this holdout, but neither accepts a decision at the unchanged 0.8 gate. GLiClass accepts 34/120 with zero observed errors (16 basic, 3 general, 15 advanced); it is a candidate for further selective-routing validation, not a replacement proven superior to JEV. JEV and Gemma remain substantially stronger overall. No live model is changed.

## Selected development variants

| Model | Variant | Correct /200 | Accepted at 0.8 | Wrong accepted |
| --- | --- | --- | --- | --- |
| jeff | json-category | 94 | 0 | 0 |
| gliclass | json-category | 118 | 45 | 3 |
| horizon | json-difficulty | 136 | 0 | 0 |
| laya-english | choice-json-capability | 133 | 7 | 0 |
| laya-typed-decisions | choice-json-capability | 137 | 0 | 0 |
| laya-multilingual | choice-json-difficulty | 128 | 69 | 14 |

Six variants were tested for each new model. Laya selections come from the earlier 20-variant experiments; the search budgets differ. The first variant in declared order wins development accuracy ties. No confidence thresholds or temperatures were fitted.

## Fresh holdout

| Model | Correct /120 | EN /60 | DE /60 | Accepted | Wrong accepted | p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| jeff | 68 (56.7%) | 33 | 35 | 0 | 0 | 87 / 107 |
| gliclass | 74 (61.7%) | 36 | 38 | 34 | 0 | 73 / 282 |
| horizon | 88 (73.3%) | 44 | 44 | 0 | 0 | 17 / 28 |
| laya-english | 80 (66.7%) | 42 | 38 | 2 | 0 | 16 / 17 |
| laya-typed-decisions | 88 (73.3%) | 49 | 39 | 0 | 0 | 15 / 17 |
| laya-multilingual | 76 (63.3%) | 41 | 35 | 47 | 9 | 7 / 7 |
| jev (API reference) | 112 (93.3%) | 56 | 56 | 100 | 2 | 266 / 342 |
| gemma (API reference) | 112 (93.3%) | 59 | 53 | 120 | 8 | 269 / 312 |

Accepted means selected probability ≥0.8 for local models. JEV/Gemma references use the production gate/status; Gemma is a label-only classifier, so its acceptance is not confidence-calibrated. Zero accepted errors with very few accepted decisions is not evidence of zero risk. All wrong predictions count against accuracy even when rejected.

## Local error direction and calibration

| Model | Under-tier | Over-tier | Invalid | Brier ↓ |
| --- | --- | --- | --- | --- |
| jeff | 35 | 17 | 0 | 0.588 |
| gliclass | 33 | 13 | 0 | 0.438 |
| horizon | 21 | 11 | 0 | 0.607 |
| laya-english | 16 | 24 | 0 | 0.462 |
| laya-typed-decisions | 14 | 18 | 0 | 0.499 |
| laya-multilingual | 22 | 22 | 0 | 0.502 |

## Runtime and interpretation limits

The initial GLiClass run inherited BF16 and produced 39/1,200 distributions outside the sum tolerance. CPU diagnostics reproduced the rounding. The full development sweep was rerun in explicit FP32 before selection; all 1,200 FP32 distributions were valid. The BF16 records are preserved under `gliclass-bf16-diagnostic/` and excluded from the final selection.

The new classifiers use PyTorch MPS on Apple silicon; Laya uses MLX FP16. Reported local latency includes tokenization and device synchronization, excludes loading and one development warmup, and uses one request at a time. CPU/GPU runtime and precision differ across families; API timings include network and gateway classifier handling.

jeff preserves its upstream normalized sigmoid scores and temperature 3.2; GLiClass uses single-label softmax; Horizon uses exclusive NLI entailment scores normalized across the four candidates. These distributions are not equivalently calibrated. No model was fine-tuned, no threshold lowered, and no live settings changed.

The same author and tier rubric were used for development and holdout. Prompts are short, self-contained text, with no attachments or history; language and class balance do not match production prevalence. Passing this holdout does not establish attachment handling, production accuracy or downstream task success. Fresh independent traffic and threshold calibration would be required before deployment.

See [protocol](../PROTOCOL.md), [reproduction](../README.md), per-call JSONL and pinned model/runtime metadata alongside this report.
