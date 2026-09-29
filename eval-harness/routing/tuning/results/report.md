# Frozen multilingual Laya routing head: fresh 200-prompt test

A specialized 3,076-parameter linear head over the frozen 322M multilingual Laya encoder improves routing accuracy and coverage. Temperature is fitted separately on old calibration data; the acceptance gate stays at 0.8.

| Router | Correct / all | Accepted correct | Accepted precision | Coverage | Median gateway time |
| --- | --- | --- | --- | --- | --- |
| laya | 192/200 (96.0%) | 188/191 | 98.4% | 95.5% | 6 ms |
| jev | 192/200 (96.0%) | 158/158 | 100.0% | 79.0% | 250 ms |
| gemma | 181/200 (90.5%) | 181/198 | 91.4% | 99.0% | 270 ms |
| laya_affine_baseline | 164/200 (82.0%) | 118/129 | 91.5% | 64.5% | 14 ms |

## What changed

The old affine approach only had four output scores. The new readout sees the 768-dimensional mean encoder representation of the JSON task state. It retains the typed choice prefix and four activity descriptions, L2-normalizes features, and runs a trained linear softmax head. The original transformer encoder and decision-head weights are unchanged; the original decision head is not executed by the production readout. Three tiers sum the middle two probabilities.

The head uses 520 previously inspected development cases. Selection compares all three checkpoints, three representations and four fixed penalties using grouped five-fold development predictions. Known translation pairs in the prompting dataset remain in the same fold; older sets are ordinal-grouped and thematic overlap can cross folds. Multilingual and typed encoders both reached 482/520; lower development log loss selected multilingual. The separate old 120-case calibration set fits one temperature (no threshold search). All fitting and model selection preceded new test authoring/inference. A later deterministic reproduction retains all 18,720 development predictions and confirms every selected coefficient and temperature is unchanged.

## Confidence and fallback

- before_temperature: mean confidence 84.9%, correctness Brier 0.0456, 10-bin ECE 12.1%, accepted at 0.8: 143/200.
- after_temperature: mean confidence 97.7%, correctness Brier 0.0221, 10-bin ECE 1.6%, accepted at 0.8: 193/200.

Temperature leaves labels unchanged. It addresses underconfidence for this trained head; it cannot repair a wrong zero-shot label. Confidence is calibrated selected-class probability, not the upstream entropy-derived concentration score. Low confidence and unavailable processes still preserve the configured route.

## Actual plugin verification

All eligible production distributions match frozen candidate inference to within 1e-6. The same disclosure guard excludes two cases for all three routers; they remain unresolved/incorrect in the 200-case denominator. JEV has one additional invalid-response result. There are no retries. The final exported artifact pins weights, encoder config and tokenizer hashes. Local metadata files not used in inference are excluded by export; this changes no fitted coefficient. The intermediate production run is retained, followed by a numerical regression run of the final export.

Three-tier grouping: 194/200 correct, 190/193 accepted correct. This was declared before fresh inference, but these are the same cases as the four-tier test.

## Class and language audit

| Tier | Laya correct / expected | Predicted |
| --- | --- | --- |
| basic | 49/50 | 49 |
| economy | 49/50 | 51 |
| general | 47/50 | 49 |
| advanced | 47/50 | 49 |

en: 95/100 correct; 92/93 accepted correct.

de: 97/100 correct; 96/98 accepted correct.

## Limits

This meets the declared Gemma accuracy/coverage target on this test. It does not establish production-wide superiority. The 200 synthetic cases have 100 correlated bilingual scenarios, one author, thematic overlap with development, and explicit specialist wording. Labels express the routing rubric, not downstream answer quality. Both technical facts and routine text about technical subjects are included, but real follow-ups, attachments and full histories are outside this classifier input contract. Confidence calibration uses only 120 cases. Inspect class boundaries and broader traffic before generalizing.

Regression smoke checks accept Calculate 1+1, Berechne 2+4, Hallo and Hello as basic. A terse request, Debug this Python error., is misclassified as basic at 56.3% and rejected by the 0.8 gate; short context-free requests remain a limitation. These checks were added after fresh validation and are not held-out selection evidence.

The live gateway and installed configuration were not modified or restarted. The source plugin needs reload/setup/start as applicable. Full raw results, development variants and provenance remain alongside this report.
