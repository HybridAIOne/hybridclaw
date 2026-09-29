# JevBench public subset — 2026-09-29

231 public cases per engine: easy 48, original 72, hard 111. This is not the official leaderboard composite: its sealed/private and imported cohorts are unavailable. All five engines receive the same canonical state and typed question. No routing tier prompt, confidence gate, retry or fallback is applied.

| Engine | Correct | Easy | Original | Hard | p50 / p95 | Valid |
| --- | --- | --- | --- | --- | --- | --- |
| jev | 199/231 (86.1%) | 100.0% | 98.6% | 72.1% | 318 / 393 ms | 231/231 |
| gemma | 172/231 (74.5%) | 100.0% | 91.7% | 52.3% | 1829 / 3349 ms | 230/231 |
| laya-english | 135/231 (58.4%) | 95.8% | 69.4% | 35.1% | 16 / 61 ms | 231/231 |
| laya-typed-decisions | 124/231 (53.7%) | 97.9% | 65.3% | 27.0% | 14 / 86 ms | 231/231 |
| laya-multilingual | 109/231 (47.2%) | 89.6% | 40.3% | 33.3% | 9 / 39 ms | 231/231 |

## Typed questions

| Engine | choice (139) | noul / boolean (74) | score / ordinal (18) |
| --- | --- | --- | --- |
| jev | 123/139 (88.5%) | 62/74 (83.8%) | 14/18 (77.8%) |
| gemma | 106/139 (76.3%) | 52/74 (70.3%) | 14/18 (77.8%) |
| laya-english | 79/139 (56.8%) | 43/74 (58.1%) | 13/18 (72.2%) |
| laya-typed-decisions | 70/139 (50.4%) | 44/74 (59.5%) | 10/18 (55.6%) |
| laya-multilingual | 70/139 (50.4%) | 35/74 (47.3%) | 4/18 (22.2%) |

Ordinal accuracy uses upstream argmax, not rounded expected score. Eighteen ordinal cases are too few to establish a general advantage.

## Confidence and context

| Engine | Probability source | Brier ↓ | ECE ↓ | State truncated |
| --- | --- | --- | --- | --- |
| jev | native | 0.180 | 0.030 | not measured |
| gemma | verbalized | 0.438 | 0.175 | not measured |
| laya-english | native | 0.533 | 0.091 | 57 |
| laya-typed-decisions | native | 0.509 | 0.072 | 37 |
| laya-multilingual | native | 0.761 | 0.296 | 44 |

On each checkpoint’s own subset with untruncated state:

- laya-english: 112/174 (64.4%).
- laya-typed-decisions: 115/194 (59.3%).
- laya-multilingual: 99/187 (52.9%).

These subsets differ by tokenizer and context limit; they are not a controlled comparison.

Brier and ECE use valid probability distributions only; invalid answers still count as incorrect in accuracy. Gemma probabilities are verbalized JSON values, not token logits or a calibrated confidence guarantee.

Laya uses native `choice`, `noul` and `score` through `laya-mlx==0.2.0` in FP16. English has a 512-token total budget; typed-decisions and multilingual have 1,024. These runs retain upstream truncation, including question/option limits. The production router rejects oversized inputs instead. English and typed-decisions also retain the runtime’s temperature clamp for the shipped `choice:11+` bucket (0.1006 becomes 0.5), but none of these public cases uses 11 or more options, so this clamp does not affect these results.

## Interpretation

This tests general typed decisions, not selection of a model tier. It confirms that using native typed questions alone does not close Laya’s quality gap on these cases. The checkpoint ordering differs from our routing prompt experiments, so choose using the intended workload. Retain JEV/Gemma as the quality baselines; these results do not justify promoting Laya as the default router.

## Reproduction and limits

See [runner instructions](../../README.md). Source revision and dataset hashes, model/checkpoint identities, weight hashes, configuration and complete aggregate metrics accompany this report. Raw requests/responses and per-item decisions remain outside the repository. No provider tariff was supplied, so cost is unknown rather than zero; ledger reservations are not bills. Latency is client-observed, serial within each engine, with remote engines running alongside one local model at a time. Local weight loading is excluded; tokenization and truncation diagnostics are included. Public cases may overlap training data; this is a single run without a held-out generalization claim.

Source: [fstandhartinger/jevbench](https://github.com/fstandhartinger/jevbench/tree/bb05a335bc809e61b20c0f745d25499a82b326fc).
