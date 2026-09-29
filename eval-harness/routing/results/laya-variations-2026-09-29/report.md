# Laya: decision type, state and question ablation

Same multilingual FP16 checkpoint and 200 labeled prompts. Twenty variants specified before this run. This reuses an inspected corpus and is exploratory; ranking variants on it is not independent validation.

State formats: raw text, JSON object with a task field, and text prefixed with User request. Choice receives named criteria; score receives the same descriptions as an ordered list. Score selects the highest-probability level, not a rounded expected value. All acceptance figures use the selected level probability ≥80%, not entropy.

| Variant | Correct /200 | EN /100 | DE /100 | Basic /50 | Accepted | Correct among accepted | Rounded score correct /200 |
|---|---:|---:|---:|---:|---:|---:|---:|
| choice-json-difficulty | 128 | 68 | 60 | 36 | 69 | 55 | — |
| choice-json-category | 128 | 68 | 60 | 35 | 73 | 55 | — |
| choice-json-capability | 121 | 65 | 56 | 34 | 67 | 50 | — |
| choice-raw-category | 117 | 61 | 56 | 35 | 48 | 37 | — |
| choice-raw-capability | 116 | 58 | 58 | 34 | 48 | 38 | — |
| choice-raw-difficulty | 115 | 61 | 54 | 37 | 47 | 37 | — |
| choice-prefixed-category | 115 | 61 | 54 | 35 | 63 | 46 | — |
| choice-prefixed-difficulty | 114 | 60 | 54 | 36 | 58 | 44 | — |
| choice-prefixed-capability | 114 | 58 | 56 | 33 | 60 | 45 | — |
| score-json-capability | 112 | 60 | 52 | 27 | 103 | 68 | 103 |
| score-prefixed-capability | 111 | 59 | 52 | 25 | 111 | 70 | 107 |
| choice-raw-neutral-labels | 111 | 54 | 57 | 31 | 89 | 59 | — |
| score-json-difficulty | 109 | 58 | 51 | 26 | 100 | 67 | 102 |
| score-json-category | 109 | 58 | 51 | 26 | 107 | 72 | 106 |
| score-prefixed-difficulty | 107 | 57 | 50 | 25 | 109 | 66 | 104 |
| choice-raw-reversed-options | 107 | 56 | 51 | 34 | 44 | 35 | — |
| score-raw-capability | 106 | 53 | 53 | 22 | 99 | 63 | 99 |
| score-prefixed-category | 106 | 57 | 49 | 24 | 122 | 76 | 104 |
| score-raw-difficulty | 104 | 52 | 52 | 23 | 98 | 62 | 97 |
| score-raw-category | 104 | 53 | 51 | 23 | 107 | 66 | 99 |

The JSON design and per-call JSONL preserve all variants and outcomes, including poor results. No variant was promoted to production and no cloud calls were made. Latency here is direct warm Python/MLX inference, not the gateway timing from the three-router comparison.
