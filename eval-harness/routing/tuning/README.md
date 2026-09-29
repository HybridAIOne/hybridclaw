# Refresh the Laya routing head

Keep training inputs, code and promoted model artifacts in Git. Put generated
features, fitted candidates, predictions and reports in ignored `cache/` or
`results/` directories. The plugin runtime and lockfile remain in
`plugins/laya-router/runtime`; fitting dependencies are in [requirements.txt](requirements.txt).

The current candidate uses a frozen multilingual Laya encoder and a linear
four-class readout. [Checkpoint pins](checkpoints.json) retain the exact three
repositories, revisions and weight hashes. The activity question comes from the
frozen [candidate](candidate.json), not a deleted experiment report.

## Inputs and validation boundaries

Development uses `../dataset.json` (200), `../calibration/test.json` (120) and
`../prompting/validation.json` (200). The separate `../alternatives/holdout.json`
(120) fits confidence temperature only. Paths and original bytes are retained so
the candidate's input hashes and split definitions stay valid.

`test.json` contains the latest inspected 200-case regression set. It is no longer
fresh evidence for a new fit. Author a new labelled test before evaluating a
changed candidate, freeze selection before inference, and never use that test's
labels for tuning. `author.py` is an authoring template: replace its example pairs
with new scenarios before generating a new test. See [PROTOCOL.md](PROTOCOL.md).

## Train and select

Use the plugin's pinned Python/MLX environment for downloads and feature
extraction. In a separate fitting environment, install `requirements.txt`.

```sh
/path/to/laya/python eval-harness/routing/tuning/download.py \
  --checkpoint typed --output eval-harness/routing/tuning/cache/models/typed
/path/to/laya/python eval-harness/routing/tuning/features.py \
  --model eval-harness/routing/tuning/cache/models/typed --output eval-harness/routing/tuning/cache/typed.npz
OPENBLAS_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1 /path/to/fitting/python \
  eval-harness/routing/tuning/fit.py --features eval-harness/routing/tuning/cache/typed.npz \
  --output eval-harness/routing/tuning/cache/typed-head.json
# Repeat for multilingual and English, with distinct output names.
/path/to/fitting/python eval-harness/routing/tuning/select.py \
  --typed eval-harness/routing/tuning/cache/typed-head.json \
  --multilingual eval-harness/routing/tuning/cache/multilingual-head.json \
  --english eval-harness/routing/tuning/cache/english-head.json \
  --output eval-harness/routing/tuning/cache/candidate.json
```

Selection compares grouped development predictions across three representations
and four penalties. The calibration slice is excluded from selection. Production
currently supports the encoder-state representation; selection fails explicitly
if another representation wins. Inspect the generated fold predictions and
candidate before promotion. Commands refuse to overwrite existing run records.

## Validate and export

```sh
/path/to/laya/python eval-harness/routing/tuning/validate.py \
  --model /path/to/selected-checkpoint \
  --candidate eval-harness/routing/tuning/cache/candidate.json \
  --dataset /path/to/new-frozen-test.json \
  --output eval-harness/routing/tuning/results/candidate.jsonl
python3 eval-harness/routing/tuning/export.py \
  --candidate eval-harness/routing/tuning/cache/candidate.json \
  --output eval-harness/routing/tuning/cache/routing-calibration.json
```

Check matched [production router comparisons](../README.md) and actual pipe
decisions before promoting the candidate and generated artifact together.
`validate.py` also accepts the retained test for regression, but its recorded
candidate hash must match; a different frozen candidate needs a newly authored
test or a regression dataset without that historical candidate binding.

To verify that the shipped artifact still reproduces without inference:

```sh
python3 eval-harness/routing/tuning/export.py --output /tmp/routing-calibration.json
cmp /tmp/routing-calibration.json plugins/laya-router/runtime/routing-calibration.json
python3 -m unittest discover -s plugins/laya-router/runtime -p 'test_*.py'
```

The runtime uses offline pinned weights and does not import fitting dependencies.
Reload/setup/start are explicit user actions; training does not change the live
gateway or installed configuration.
