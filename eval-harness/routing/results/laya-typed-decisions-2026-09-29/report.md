# Laya: decision type, state and question ablation

Checkpoint: aac6fef/laya-typed-decisions-mlx@f9e501c2080cc57c13d6887820329758f5351125. FP16, same 200 labeled prompts. Twenty variants specified before this run. This reuses an inspected corpus and is exploratory; ranking variants on it is not independent validation.

State formats: raw text, JSON object with a task field, and text prefixed with User request. Choice receives named criteria; score receives the same descriptions as an ordered list. Score selects the highest-probability level, not a rounded expected value. All acceptance figures use the selected level probability ≥80%, not entropy.

| Variant | Correct /200 | EN /100 | DE /100 | Basic /50 | Accepted | Correct among accepted | Rounded score correct /200 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice-json-capability | 137 | 73 | 64 | 35 | 0 | 0 | — |
| choice-prefixed-difficulty | 132 | 66 | 66 | 31 | 0 | 0 | — |
| choice-json-difficulty | 129 | 67 | 62 | 28 | 0 | 0 | — |
| choice-json-category | 129 | 68 | 61 | 31 | 0 | 0 | — |
| choice-prefixed-capability | 129 | 68 | 61 | 37 | 0 | 0 | — |
| score-json-difficulty | 129 | 72 | 57 | 22 | 0 | 0 | 85 |
| score-json-capability | 128 | 70 | 58 | 22 | 0 | 0 | 86 |
| choice-raw-capability | 126 | 69 | 57 | 33 | 0 | 0 | — |
| score-json-category | 126 | 68 | 58 | 22 | 2 | 2 | 86 |
| choice-raw-neutral-labels | 126 | 69 | 57 | 24 | 0 | 0 | — |
| score-prefixed-category | 124 | 66 | 58 | 27 | 2 | 2 | 86 |
| score-prefixed-capability | 123 | 66 | 57 | 28 | 1 | 1 | 86 |
| choice-prefixed-category | 122 | 66 | 56 | 31 | 0 | 0 | — |
| choice-raw-difficulty | 119 | 68 | 51 | 29 | 0 | 0 | — |
| score-raw-category | 119 | 66 | 53 | 20 | 0 | 0 | 75 |
| choice-raw-category | 118 | 67 | 51 | 29 | 0 | 0 | — |
| score-prefixed-difficulty | 118 | 65 | 53 | 24 | 0 | 0 | 86 |
| score-raw-capability | 115 | 66 | 49 | 18 | 0 | 0 | 78 |
| choice-raw-reversed-options | 115 | 67 | 48 | 30 | 0 | 0 | — |
| score-raw-difficulty | 113 | 66 | 47 | 15 | 0 | 0 | 75 |

The JSON design and per-call JSONL preserve all variants and outcomes, including poor results. No variant was promoted to production and no cloud calls were made. Latency here is direct warm Python/MLX inference, not the gateway timing from the three-router comparison.
