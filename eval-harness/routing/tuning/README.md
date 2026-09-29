# Specialized multilingual Laya router

[Protocol](PROTOCOL.md), [fresh 200-prompt test](test.json), [full report](results/report.md).

The selected 322M multilingual checkpoint supplies frozen encoder features to a
3,076-parameter linear routing head. Training uses 520 previously inspected
synthetic prompts; 120 separate old prompts calibrate one temperature. The new
200 cases are authored after selection is frozen and compared with the previous
affine Laya plugin, JEV and Gemma through the same gateway gates. No private
session histories or live settings are used.

All three checkpoints, three feature representations and four penalties were
tested in grouped five-fold development comparisons. The selected coefficients
and temperature reproduce exactly; all 18,720 fold predictions are retained in
`results/laya-*-cv.jsonl`. The feature caches are local reproducible NumPy files,
not shipped model assets. Their hashes are recorded with development results.
The original transformer weights are not trained. Production skips the original
decision head; this is a specialized classifier, not zero-shot Laya.

The final runtime reaches 96% label accuracy, 98.4% accepted precision and 95.5%
coverage at the existing 0.8 gate on this test. Synthetic paired cases and a
small calibration set cannot establish quality on all real traffic. See the
report for class/language results, errors and confidence metrics.

## Reproduction

Inference uses the plugin's `laya-mlx==0.2.0` / MLX 0.32.3 / NumPy 2.5.3 FP16
environment. Fitting uses NumPy 2.5.3 and SciPy 1.18.1; fitting dependencies are
unshipped and are not imported by the production worker. The three checkpoint
identities and hashes are in `../calibration/results/laya-*.metadata.json`.
Set `--model` to a local checkpoint downloaded at that exact revision.

Use a fresh output directory/workspace for a new inference run; commands refuse
to overwrite records. Existing reports can be audited without model execution.
For each checkpoint:

```sh
/path/to/laya/python eval-harness/routing/tuning/features.py --model /path/to/checkpoint --output /tmp/laya-tuning-typed.npz
OPENBLAS_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1 /path/to/fitting/python eval-harness/routing/tuning/fit.py --features /tmp/laya-tuning-typed.npz --output /tmp/laya-tuning-typed-head.json
# Repeat for multilingual and English, using matching cache/output names.
/path/to/fitting/python eval-harness/routing/tuning/select.py --typed /tmp/laya-tuning-typed-head.json --multilingual /tmp/laya-tuning-multilingual-head.json --english /tmp/laya-tuning-english-head.json --output /tmp/selected-candidate.json
```

Place the selected candidate in a fresh copy of this workspace as `candidate.json`
and format it before freezing its byte hash and authoring new test inputs.
`author.py` rejects exact overlap with all earlier cases. Do not reuse the current
test as independent evidence for a later fit. To audit the retained evidence:

```sh
python3 eval-harness/routing/tuning/report.py
python3 -m unittest discover -s plugins/laya-router/runtime -p 'test_*.py'
```

To reproduce inference in a fresh workspace:

```sh
/path/to/laya/python eval-harness/routing/tuning/validate.py --model /path/to/multilingual-checkpoint
node --import tsx eval-harness/routing/alternatives/remote.mjs --dataset eval-harness/routing/tuning/test.json --output eval-harness/routing/tuning/results
python3 eval-harness/routing/tuning/export.py --output /tmp/routing-calibration.json
# Install the generated artifact in a temporary plugin checkout before pipe verification.
node --import tsx eval-harness/routing/prompting/production.mjs --python /path/to/laya/python --model /path/to/multilingual-checkpoint --dataset eval-harness/routing/tuning/test.json --output eval-harness/routing/tuning/results/production-final.jsonl
```

The old affine baseline record binds to commit `603f1f136`; its plugin must be
run at that commit to reproduce that baseline. Intermediate/final pipe runs are
retained and differ only in which metadata files the artifact requires for setup.
The final export pins only the weights and four config/tokenizer files serving
actually reads. Explicit setup was also exercised against a new temporary model
directory and completed its weight/config integrity checks.
