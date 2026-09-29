# Frozen Laya router versus JEV on 200 fresh prompts

The production plugin uses typed-decisions, a JSON task state, an activity/category choice question, affine four-class calibration fitted on 200 development prompts, and a separate correctness map fitted on the earlier 120 calibration cases. All four-tier fits and wording were frozen before validation inference. No neural weights were trained.

| Router | All-case correct | Macro class precision | Accepted correct | Accepted precision | Coverage | Median gateway time |
| --- | --- | --- | --- | --- | --- | --- |
| laya | 174/200 (87.0%) | 88.8% | 131/138 | 94.9% | 69.0% | 15 ms |
| jev | 193/200 (96.5%) | 98.1% | 170/170 | 100.0% | 85.0% | 242 ms |
| gemma | 185/200 (92.5%) | 94.8% | 185/198 | 93.4% | 99.0% | 267 ms |

## Target audit

Both percentage-point and relative differences are below 10% for accepted precision, macro class precision and overall label accuracy. Coverage remains lower than JEV. These are observed point estimates, not proof of population noninferiority.

| Metric | Gap to JEV in percentage points | Relative gap |
| --- | --- | --- |
| precision | 5.07 | 5.07% |
| macro_precision | 9.37 | 9.54% |
| accuracy | 9.50 | 9.84% |

## Class boundaries

All available predicted labels, including low-confidence classifications. Blocked prompts have no predicted label and remain incorrect/unresolved in overall accuracy.

| Class | Laya precision | Laya recall | JEV precision | JEV recall |
| --- | --- | --- | --- | --- |
| basic | 94.7% | 72.0% | 92.6% | 100.0% |
| economy | 78.3% | 94.0% | 100.0% | 94.0% |
| general | 91.7% | 88.0% | 100.0% | 92.0% |
| advanced | 90.4% | 94.0% | 100.0% | 100.0% |

Economy remains the weakest class; no per-class parity claim is made. Per-language counts and Wilson intervals are retained in `summary.json`.

## Gates and actual runtime

JEV and the production Laya path exclude the same two prompts under the existing disclosure guard. Direct candidate inference accepted 140 with 131 correct; the actual gateway excludes two wrong accepted decisions, giving 138 accepted with 131 correct. The report uses the same gateway policy for both models and leaves the gate at 0.8. The guard is not modified to make the test pass. Gemma requests resolve through the currently configured local vLLM provider; this differs from earlier remote-provider timings.

Three-tier regression: 176/200 correct, 149 accepted, 141 accepted correct. The two middle bands are summed and the correctness map is fitted on grouped old calibration labels. This grouping was added after the four-tier validation was inspected; it is a regression check, not a fresh independent three-tier model-selection result.

## Selection and limits

All three checkpoints received the same 16 declared development variants (9,600 predictions). Best development accuracy: typed-decisions 152/200, English 137/200, multilingual 128/200. A 20-coefficient affine map selected with development cross-validation reached 165/200; final four-tier validation was 174/200. Retain every variant, including poor ones. Prompt/model and regularizer selection reuse development data; only the new validation is separate.

The 200 validation prompts are balanced, same-author synthetic rubric cases; 100 bilingual scenario pairs are correlated. Exact text overlap with all earlier sets is rejected. No real session text or credentials are included. Strong specialist wording can make advanced tasks easier to recognize than ambiguous real traffic. Accepted precision does not measure downstream answer quality. Confidence intervals are descriptive and may understate correlation. This experiment establishes the requested gap on this dataset, not production-wide quality guarantees.

The exact worker, model weights, production calibration artifact and test inputs are hash-verified. Every eligible four-tier pipe prediction matches the frozen candidate within numerical tolerance. The source plugin is updated; the live gateway, installed weights and settings are unchanged. Setup and plugin reload are required to use it.
