# Routing comparison: 200 synthetic prompts

Run: 2026-09-29T17:32:52.218Z · Source commit: `9a387135b02d`

Balanced rubric benchmark: 50 cases per tier, 100 English and 100 German. Labels were authored before inference. Prompts are synthetic and inspired only by aggregate session themes; no historical message text was submitted. This measures adherence to the routing rubric, not downstream answer quality.

Production timeout: 1500 ms. Typed-router threshold: 80%. Rejected or failed decisions use the configured `basic` tier. No retries. Gemma produces a tier without a probability, so every valid Gemma answer is accepted. JEV uses its reported confidence; Laya uses selected-option probability. Those scores are not directly comparable.

| Router | Raw correct / all | Valid decisions | Accepted | Correct among accepted | Correct after default fallback | p50 / p95 latency |
|---|---:|---:|---:|---:|---:|---:|
| jev | 183/200 (91.5%) | 199/200 | 167/200 (83.5%) | 164/167 (98.2%) | 166/200 (83.0%) | 251 / 303 ms |
| laya | 115/200 (57.5%) | 200/200 | 47/200 (23.5%) | 37/47 (78.7%) | 61/200 (30.5%) | 16 / 20 ms |
| gemma | 183/200 (91.5%) | 200/200 | 200/200 (100.0%) | 183/200 (91.5%) | 183/200 (91.5%) | 264 / 294 ms |

Latency includes the production classifier wrapper and remote round trip; Laya model startup is excluded, but first inference is included. Default-fallback outcomes simulate tiers before model selection or manual escalation. Calls run concurrently across the three engines and sequentially within each engine. Prompts run in dataset order, so tier and run order are confounded. Gemma is hosted through the configured endpoint, not run on the same Mac.

## Accuracy by language and tier

| Slice | JEV | Laya | Gemma |
|---|---:|---:|---:|
| en | 91/100 (91.0%) | 61/100 (61.0%) | 98/100 (98.0%) |
| de | 92/100 (92.0%) | 54/100 (54.0%) | 85/100 (85.0%) |
| basic | 49/50 (98.0%) | 37/50 (74.0%) | 34/50 (68.0%) |
| economy | 39/50 (78.0%) | 23/50 (46.0%) | 50/50 (100.0%) |
| general | 45/50 (90.0%) | 32/50 (64.0%) | 49/50 (98.0%) |
| advanced | 50/50 (100.0%) | 23/50 (46.0%) | 50/50 (100.0%) |

## Post-hoc fallback replay

These are simulations over saved predictions, not additional live runs. They replace the configured Basic fallback with Gemma when the primary abstains or fails. Serial latency was not measured; selecting a policy on this dataset requires fresh validation.

| Primary → fallback | Correct | Gemma calls needed |
|---|---:|---:|
| jev → gemma | 195/200 (97.5%) | 33/200 |
| laya → gemma | 180/200 (90.0%) | 153/200 |

## Confusion matrices

Rows are expected tiers; columns are raw predictions. Rejected low-confidence predictions remain visible.

### jev

| Expected | basic | economy | general | advanced | No valid choice |
|---|---:|---:|---:|---:|---:|
| basic | 49 | 0 | 0 | 0 | 1 |
| economy | 11 | 39 | 0 | 0 | 0 |
| general | 5 | 0 | 45 | 0 | 0 |
| advanced | 0 | 0 | 0 | 50 | 0 |

### laya

| Expected | basic | economy | general | advanced | No valid choice |
|---|---:|---:|---:|---:|---:|
| basic | 37 | 8 | 5 | 0 | 0 |
| economy | 12 | 23 | 13 | 2 | 0 |
| general | 7 | 3 | 32 | 8 | 0 |
| advanced | 2 | 2 | 23 | 23 | 0 |

### gemma

| Expected | basic | economy | general | advanced | No valid choice |
|---|---:|---:|---:|---:|---:|
| basic | 34 | 16 | 0 | 0 | 0 |
| economy | 0 | 50 | 0 | 0 | 0 |
| general | 0 | 1 | 49 | 0 | 0 |
| advanced | 0 | 0 | 0 | 50 | 0 |

## Tokens and estimated cost

| Router | Input tokens | Output tokens | Reported/estimated cost |
|---|---:|---:|---:|
| jev | 77,505 (partial) | 9,431 (partial) | $0.003255 (partial) |
| laya | 16,343 | 0 | $0.000000 |
| gemma | 32,880 | 1,200 | $0.007498 |

Local zero cost means no API fee; hardware and electricity are excluded. Missing cost is not zero.

## Misclassifications and failures

| Case | Language | Expected | Router | Raw choice | Confidence | Accepted |
|---|---|---|---|---|---:|---|
| route-010 | en | basic | laya | economy | 99.8% | Yes |
| route-014 | en | basic | laya | general | 59.6% | No |
| route-015 | en | basic | jev | No valid choice | — | No |
| route-015 | en | basic | laya | general | 37.8% | No |
| route-015 | en | basic | gemma | economy | — | Yes |
| route-017 | en | basic | laya | general | 78.0% | No |
| route-020 | en | basic | laya | economy | 56.3% | No |
| route-021 | en | basic | laya | economy | 46.1% | No |
| route-021 | en | basic | gemma | economy | — | Yes |
| route-022 | en | basic | laya | general | 71.4% | No |
| route-030 | de | basic | gemma | economy | — | Yes |
| route-032 | de | basic | gemma | economy | — | Yes |
| route-035 | de | basic | laya | economy | 46.3% | No |
| route-036 | de | basic | laya | economy | 97.7% | Yes |
| route-036 | de | basic | gemma | economy | — | Yes |
| route-038 | de | basic | gemma | economy | — | Yes |
| route-039 | de | basic | gemma | economy | — | Yes |
| route-040 | de | basic | laya | economy | 89.4% | Yes |
| route-040 | de | basic | gemma | economy | — | Yes |
| route-041 | de | basic | gemma | economy | — | Yes |
| route-042 | de | basic | gemma | economy | — | Yes |
| route-043 | de | basic | laya | general | 85.0% | Yes |
| route-043 | de | basic | gemma | economy | — | Yes |
| route-044 | de | basic | gemma | economy | — | Yes |
| route-045 | de | basic | gemma | economy | — | Yes |
| route-046 | de | basic | laya | economy | 96.2% | Yes |
| route-046 | de | basic | gemma | economy | — | Yes |
| route-047 | de | basic | laya | economy | 64.3% | No |
| route-047 | de | basic | gemma | economy | — | Yes |
| route-048 | de | basic | gemma | economy | — | Yes |
| route-051 | en | economy | laya | basic | 53.7% | No |
| route-056 | en | economy | jev | basic | 40.0% | No |
| route-056 | en | economy | laya | basic | 35.4% | No |
| route-058 | en | economy | laya | basic | 59.1% | No |
| route-059 | en | economy | jev | basic | 70.0% | No |
| route-059 | en | economy | laya | basic | 44.1% | No |
| route-060 | en | economy | jev | basic | 40.0% | No |
| route-063 | en | economy | laya | general | 45.4% | No |
| route-064 | en | economy | laya | basic | 55.7% | No |
| route-065 | en | economy | laya | general | 54.5% | No |
| route-066 | en | economy | laya | basic | 49.4% | No |
| route-069 | en | economy | laya | general | 66.9% | No |
| route-070 | en | economy | jev | basic | 38.0% | No |
| route-071 | en | economy | jev | basic | 38.0% | No |
| route-071 | en | economy | laya | general | 75.3% | No |
| route-072 | en | economy | laya | general | 42.4% | No |
| route-073 | en | economy | jev | basic | 40.0% | No |
| route-073 | en | economy | laya | general | 83.6% | Yes |
| route-074 | en | economy | laya | general | 34.2% | No |
| route-079 | de | economy | laya | basic | 62.9% | No |
| route-080 | de | economy | laya | basic | 39.0% | No |
| route-081 | de | economy | jev | basic | 63.0% | No |
| route-081 | de | economy | laya | basic | 63.4% | No |
| route-083 | de | economy | laya | basic | 46.7% | No |
| route-084 | de | economy | jev | basic | 76.0% | No |
| route-084 | de | economy | laya | basic | 70.9% | No |
| route-085 | de | economy | jev | basic | 66.0% | No |
| route-089 | de | economy | laya | general | 38.6% | No |
| route-090 | de | economy | laya | basic | 43.1% | No |
| route-092 | de | economy | laya | general | 51.4% | No |
| route-094 | de | economy | laya | general | 92.2% | Yes |
| route-095 | de | economy | jev | basic | 44.0% | No |
| route-095 | de | economy | laya | advanced | 54.7% | No |
| route-096 | de | economy | laya | advanced | 42.7% | No |
| route-097 | de | economy | laya | general | 65.2% | No |
| route-098 | de | economy | jev | basic | 56.0% | No |
| route-099 | de | economy | laya | general | 82.5% | Yes |
| route-100 | de | economy | laya | general | 72.7% | No |
| route-103 | en | general | laya | advanced | 53.2% | No |
| route-104 | en | general | laya | basic | 36.8% | No |
| route-106 | en | general | jev | basic | 86.0% | Yes |
| route-106 | en | general | laya | economy | 93.3% | Yes |
| route-107 | en | general | laya | advanced | 66.7% | No |
| route-108 | en | general | laya | advanced | 46.2% | No |
| route-109 | en | general | laya | basic | 42.4% | No |
| route-113 | en | general | laya | advanced | 63.2% | No |
| route-117 | en | general | jev | basic | 62.0% | No |
| route-124 | en | general | laya | advanced | 49.3% | No |
| route-125 | en | general | laya | basic | 37.3% | No |
| route-128 | de | general | laya | economy | 60.3% | No |
| route-129 | de | general | laya | advanced | 32.4% | No |
| route-131 | de | general | jev | basic | 81.0% | Yes |
| route-131 | de | general | laya | economy | 46.3% | No |
| route-132 | de | general | laya | advanced | 46.5% | No |
| route-133 | de | general | laya | basic | 35.1% | No |
| route-135 | de | general | laya | basic | 44.4% | No |
| route-142 | de | general | jev | basic | 88.0% | Yes |
| route-142 | de | general | laya | basic | 65.9% | No |
| route-142 | de | general | gemma | economy | — | Yes |
| route-148 | de | general | laya | advanced | 38.7% | No |
| route-150 | de | general | jev | basic | 26.0% | No |
| route-150 | de | general | laya | basic | 34.2% | No |
| route-152 | en | advanced | laya | economy | 44.9% | No |
| route-153 | en | advanced | laya | general | 36.1% | No |
| route-155 | en | advanced | laya | general | 54.6% | No |
| route-161 | en | advanced | laya | general | 31.6% | No |
| route-162 | en | advanced | laya | general | 41.1% | No |
| route-163 | en | advanced | laya | general | 42.0% | No |
| route-166 | en | advanced | laya | general | 38.8% | No |
| route-170 | en | advanced | laya | general | 59.7% | No |
| route-171 | en | advanced | laya | general | 52.0% | No |
| route-174 | en | advanced | laya | general | 39.7% | No |
| route-177 | de | advanced | laya | general | 47.9% | No |
| route-178 | de | advanced | laya | general | 81.9% | Yes |
| route-179 | de | advanced | laya | general | 32.1% | No |
| route-180 | de | advanced | laya | economy | 53.2% | No |
| route-181 | de | advanced | laya | basic | 42.7% | No |
| route-182 | de | advanced | laya | general | 75.2% | No |
| route-183 | de | advanced | laya | general | 40.5% | No |
| route-184 | de | advanced | laya | general | 74.6% | No |
| route-185 | de | advanced | laya | general | 43.7% | No |
| route-186 | de | advanced | laya | general | 42.4% | No |
| route-187 | de | advanced | laya | general | 62.2% | No |
| route-188 | de | advanced | laya | general | 55.0% | No |
| route-189 | de | advanced | laya | general | 66.3% | No |
| route-192 | de | advanced | laya | general | 64.9% | No |
| route-195 | de | advanced | laya | general | 35.8% | No |
| route-196 | de | advanced | laya | general | 65.0% | No |
| route-197 | de | advanced | laya | basic | 38.9% | No |

## Interpretation limits

- These labels encode the authored four-tier rubric, not experimentally measured minimum model capability.
- Equal tier counts are a stress-test design, not the observed frequency of actual user tasks.
- Advanced cases emphasize specialist reasoning and proofs; some English/German cases are semantic counterparts. Cases are not independent random samples of traffic.
- No prompt tuning or threshold changes were made using this dataset. The dataset becomes regression material after this run.
- One run per case; network load, provider changes and calibration may affect results. No calibrated correctness claim follows from model confidence.
- Current-message-only classification: no conversation history, attachments or actual downstream task execution.

Dataset SHA-256: `001b835280e85be61b7424eb6a0fb737cca533c7f5bbbc9a4a312ae4f8349aa6`
