# Laya calibration on fresh test prompts — 2026-09-29

Fit each checkpoint on the previously inspected 120-prompt holdout, then freeze the maps before creating and evaluating this new 120-prompt English/German test. Model weights, choice variants and tier predictions stay unchanged. No thresholds were selected using this test.

## Primary acceptance gate: 0.8

| Checkpoint | Overall correct | Raw accepted (wrong) | Calibrated accepted (wrong) | Calibrated accepted accuracy | Nominal 95% interval |
| --- | --- | --- | --- | --- | --- |
| laya-english | 75/120 | 2 (0) | 43 (4) | 90.7% | 78.4–96.3% |
| laya-typed-decisions | 89/120 | 0 (0) | 48 (2) | 95.8% | 86.0–98.8% |
| laya-multilingual | 81/120 | 50 (10) | 19 (0) | 100.0% | 83.2–100.0% |

## Confidence quality on all test predictions

Binary correctness metrics, not the multiclass Brier score used in earlier reports. Lower is better. ECE uses ten fixed equal-width bins and is noisy on this small sample.

| Checkpoint | Mean raw → calibrated confidence | Accuracy | Brier raw → calibrated | NLL raw → calibrated | ECE raw → calibrated |
| --- | --- | --- | --- | --- | --- |
| laya-english | 54.1% → 69.1% | 62.5% | 0.197 → 0.190 | 0.579 → 0.543 | 0.105 → 0.096 |
| laya-typed-decisions | 43.6% → 72.4% | 74.2% | 0.262 → 0.161 | 0.719 → 0.471 | 0.306 → 0.076 |
| laya-multilingual | 73.1% → 65.0% | 67.5% | 0.192 → 0.190 | 0.558 → 0.558 | 0.089 → 0.072 |

## Fixed conservative gate: 0.95

| Checkpoint | Accepted | Wrong | Accepted accuracy |
| --- | --- | --- | --- |
| laya-english | 13 | 0 | 100.0% |
| laya-typed-decisions | 14 | 0 | 100.0% |
| laya-multilingual | 0 | 0 | — |

## Frozen maps and equivalent raw cutoffs

| Checkpoint | a | b | Raw cutoff for calibrated 0.8 | Raw cutoff for calibrated 0.95 |
| --- | --- | --- | --- | --- |
| laya-english | 2.0043 | 0.7079 | 0.5838 | 0.7532 |
| laya-typed-decisions | 3.6085 | 2.2321 | 0.4417 | 0.5492 |
| laya-multilingual | 0.5337 | -0.0193 | 0.9330 | 0.9961 |

The monotone map changes the meaning of confidence and which decisions pass a gate; it cannot fix incorrect tier choices or improve their ranking. It estimates correctness of the winning tier, not a four-class probability distribution. The equivalent raw cutoffs make the increased/decreased acceptance explicit.

## Limits and deployment

Both sets are small, balanced, same-author synthetic rubric data. Some English/German cases share scenarios, so the per-prompt Wilson intervals are descriptive and may understate uncertainty from correlation. Coverage and accuracy need validation on independent real traffic, particularly attachments, history and ambiguous tier boundaries. A calibrated score of 0.95 is not a guaranteed 95% success rate; the secondary gate was fixed before testing and is not a recommended production threshold.

No live model, confidence policy, weights or gateway process was changed. See [protocol](../PROTOCOL.md) and [reproduction](../README.md). Per-language metrics are in `summary.json`.
