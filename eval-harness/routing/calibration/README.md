# Laya correctness calibration

[Fresh-test report](results/report.md), [predeclared method](PROTOCOL.md), [frozen coefficients](frozen.json), [new test data](test.json).

The earlier 120-prompt alternatives holdout is now calibration data, not validation evidence. Fit a separate positive-slope logistic map from each checkpoint's selected probability to the probability that its winning tier is correct. The three maps were frozen before the new test was authored or scored. Neither the model's tier nor its four-class distribution is changed.

## Reproduction

Fit with Python 3.12, NumPy 2.5.3 and SciPy 1.18.1, as recorded in the alternatives evaluation environment. This command uses only the old per-call calibration records and refuses to overwrite its output:

```sh
/path/to/calibration/python eval-harness/routing/calibration/calibrate.py --output /tmp/reproduced-calibration.json
```

The checked-in `frozen.json` is the exact artifact consumed by test inference. Compare the reproduced coefficients before running anything on new data. No post-test refitting or threshold selection is part of this experiment.

Use the separate `laya-mlx==0.2.0` environment and the previously downloaded, revision-pinned weights. The runner verifies each weight hash against the earlier checkpoint metadata and refuses to overwrite test records:

```sh
/path/to/laya/python eval-harness/routing/calibration/run.py \
  --engine laya-english --model /path/to/english-checkpoint
```

Repeat for `laya-typed-decisions` and `laya-multilingual`. Inference uses Apple Metal, the previous JSON choice variants, and a fixed development warmup. `run.py` and `report.py` target this directory's checked-in inputs/results; use a fresh workspace for a repeated inference run. To audit the existing evidence without inference:

```sh
python3 eval-harness/routing/calibration/report.py
python3 -m unittest discover -s eval-harness/routing/calibration -p 'test_*.py'
```

The report verifies dataset/coefficient hashes, labels, winning tiers and calibrated scores. It reports all predictions, including wrong accepted decisions. Binary Brier/NLL measure correctness confidence, unlike the multiclass Brier scores in previous reports. The 0.8 and 0.95 gates were specified before inference; their actual test accuracy is not guaranteed by the threshold.

No production code, model weights, plugin settings or gateway process is changed. The evaluation adds zero production lines. Next deployment work needs independent representative traffic and a clear acceptable error rate; this small synthetic test alone does not establish either.
