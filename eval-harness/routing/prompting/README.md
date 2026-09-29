# Frozen routing specialization

[Protocol](PROTOCOL.md), [fresh-test report](results/report.md), [200 fresh prompts](validation.json).

This is the historical affine experiment, verified at commit `603f1f136`.
Its audit binds to that commit's worker/artifact; reproduce it at that commit.
The source plugin uses the subsequent [frozen encoder experiment](../tuning/README.md).

Development: 16 declared choice variants × 200 original prompts × three pinned checkpoints. Typed-decisions with JSON state and the activity/category variant wins. Preserve every outcome. Fit a 20-coefficient affine map on centered log probabilities using the original 200 cases; penalty 0.01 was selected using deterministic five-fold development comparisons. This map changes predicted labels, unlike the earlier selected-correctness calibration. Fit the separate positive-slope correctness map on 120 old calibration predictions, then freeze both before fresh validation inference.

No final test labels fit coefficients or select prompts. The fresh 200-case four-tier comparison audits direct predictions and the actual plugin child process, gateway disclosure checks and confidence gate. It includes JEV and Gemma through the same production classifiers. Three-tier grouping was added after four-tier testing and is identified as a regression check, not independent model selection. See the report for synthetic labels, correlation, coverage, weak economy precision and other limitations.

## Reproduction

Python/MLX inference: the existing `laya-mlx==0.2.0` environment with pinned FP16 checkpoints. Fit/export: Python 3.12, NumPy 2.5.3, SciPy 1.18.1. Dependencies are recorded in the preceding alternatives workspace. The production runtime needs no SciPy or fitting dependency.

Commands refuse to overwrite inference records and frozen artifacts. Use a fresh workspace for repeating inference; auditing existing evidence requires no model execution.

```sh
/path/to/laya/python eval-harness/routing/prompting/run.py --engine laya-typed-decisions --model /path/to/typed-checkpoint
# Repeat development for laya-english and laya-multilingual.
/path/to/fitting/python eval-harness/routing/prompting/specialize.py
# Reproduce the retained development comparison independently:
/path/to/fitting/python eval-harness/routing/prompting/cross_validate.py
/path/to/laya/python eval-harness/routing/prompting/validate.py --phase calibration --model /path/to/typed-checkpoint
/path/to/fitting/python eval-harness/routing/prompting/specialize.py --correctness
# Freeze before authoring/running validation.
/path/to/laya/python eval-harness/routing/prompting/validate.py --phase validation --model /path/to/typed-checkpoint
node --import tsx eval-harness/routing/alternatives/remote.mjs --dataset eval-harness/routing/prompting/validation.json --output eval-harness/routing/prompting/results
/path/to/fitting/python eval-harness/routing/prompting/export.py --output /tmp/reproduced-routing-calibration.json
cmp /tmp/reproduced-routing-calibration.json plugins/laya-router/runtime/routing-calibration.json
node --import tsx eval-harness/routing/prompting/production.mjs --python /path/to/laya/python --model /path/to/typed-checkpoint
/path/to/fitting/python eval-harness/routing/prompting/report.py
```

`export.py` generates the exact plugin artifact from immutable fitted evidence and hashes the current shared gateway rubric. Do not hand-edit its coefficients. The plugin rejects changed capability rubrics; custom tier names preserve configured ordering. Exact numerical predictions through the worker and gateway are verified against the frozen candidate. This source update does not change the live gateway or installed model.

Biome excludes the hashed JSON artifacts and generated plugin map to preserve the exact bytes used during inference. Formatting source files must not rewrite frozen experimental evidence.
