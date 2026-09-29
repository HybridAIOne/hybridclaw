# Laya: decision type, state and question ablation

Checkpoint: aac6fef/laya-mlx@20aed815fc6acde75733882e7ec0e3f28aeb9717. FP16, same 200 labeled prompts. Twenty variants specified before this run. This reuses an inspected corpus and is exploratory; ranking variants on it is not independent validation.

State formats: raw text, JSON object with a task field, and text prefixed with User request. Choice receives named criteria; score receives the same descriptions as an ordered list. Score selects the highest-probability level, not a rounded expected value. All acceptance figures use the selected level probability ≥80%, not entropy.

| Variant | Correct /200 | EN /100 | DE /100 | Basic /50 | Accepted | Correct among accepted | Rounded score correct /200 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice-json-capability | 133 | 65 | 68 | 41 | 7 | 7 | — |
| score-json-difficulty | 130 | 67 | 63 | 29 | 55 | 53 | 106 |
| score-json-capability | 130 | 67 | 63 | 32 | 50 | 46 | 105 |
| score-prefixed-capability | 127 | 67 | 60 | 38 | 40 | 37 | 101 |
| score-raw-difficulty | 125 | 66 | 59 | 28 | 32 | 31 | 100 |
| score-json-category | 125 | 63 | 62 | 31 | 62 | 55 | 107 |
| score-prefixed-difficulty | 125 | 65 | 60 | 36 | 43 | 42 | 103 |
| score-prefixed-category | 125 | 65 | 60 | 38 | 51 | 46 | 102 |
| score-raw-category | 124 | 66 | 58 | 28 | 36 | 33 | 98 |
| choice-json-difficulty | 122 | 63 | 59 | 36 | 6 | 6 | — |
| choice-json-category | 121 | 62 | 59 | 39 | 11 | 11 | — |
| score-raw-capability | 120 | 65 | 55 | 27 | 26 | 25 | 93 |
| choice-prefixed-capability | 119 | 62 | 57 | 42 | 4 | 4 | — |
| choice-raw-neutral-labels | 118 | 62 | 56 | 33 | 10 | 10 | — |
| choice-raw-capability | 116 | 62 | 54 | 41 | 0 | 0 | — |
| choice-prefixed-difficulty | 116 | 60 | 56 | 42 | 4 | 4 | — |
| choice-raw-difficulty | 114 | 61 | 53 | 39 | 0 | 0 | — |
| choice-raw-category | 112 | 63 | 49 | 38 | 2 | 2 | — |
| choice-prefixed-category | 110 | 57 | 53 | 41 | 5 | 5 | — |
| choice-raw-reversed-options | 108 | 63 | 45 | 33 | 4 | 4 | — |

The JSON design and per-call JSONL preserve all variants and outcomes, including poor results. No variant was promoted to production and no cloud calls were made. Latency here is direct warm Python/MLX inference, not the gateway timing from the three-router comparison.
