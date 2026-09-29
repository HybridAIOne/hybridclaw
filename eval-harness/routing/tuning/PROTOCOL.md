# Frozen encoder routing head

Decision, 2026-09-29: test whether a small supervised routing head recovers
information lost in Laya's four choice probabilities. The encoder and its
tokenizer remain frozen. This is a specialized classifier, not zero-shot Laya.

The desired outcome is accuracy within two percentage points of Gemma, at least
90% routing coverage at the existing 0.8 acceptance gate, and no material drop
in accepted precision. Report all results if this target is missed.

## Development and calibration

All previously inspected routing datasets are explicitly repurposed. The
original 200 cases, old calibration test 120, and earlier prompting validation
200 form 520 development cases. The alternatives holdout 120 is used only to fit
one softmax temperature after training. None of these are fresh tests anymore.

For each of the three pinned Laya checkpoints, extract FP16 inference features:
mean encoder state tokens, mean decision-head state tokens, or concatenated
decision-head option markers. State remains JSON `{"task": text}`; question and
options remain the previously selected activity/category choice formulation.
Reject state truncation. L2-normalize the resulting vector and fit a four-class
linear softmax head with mean cross entropy and half the penalty times squared
weights. Try exactly four penalties: 0.0001, 0.001, 0.01, 0.1.

Five development folds use within-class/language ordinal modulo five. Known
translation pairs in the 200-case prompting dataset therefore stay together.
Older English/German sets are grouped by ordinal but are not literal translation
pairs; thematic overlap can cross folds, so cross-validation is only a selection aid. Choose highest accuracy,
then lowest negative log likelihood, then declared order across checkpoints
(typed, multilingual, English). Refit the selected head on all 520 development
cases. Fit temperature on the separate old 120 calibration cases, bounded to
[0.1, 10]. Temperature changes confidence, never argmax. Group middle-class
probabilities for three tiers. Do not tune the gate or fit a map on test labels.

## Fresh validation

Only after all candidates have been fitted and selection is frozen, author 200
new synthetic rubric cases, 25 scenarios per tier with English/German versions.
Include terse requests and basic tasks containing technical vocabulary, routine
writing about difficult topics, practical coding, and genuinely difficult
proofs/architecture. Labels precede inference. Reject exact text overlap with
all 640 old cases. No private session text or credentials enter the corpus.

Run the selected frozen head once, plus the current affine production baseline,
JEV, and Gemma on identical inputs through production routing gates. Preserve
errors and timeouts; no retries, no selected-case omissions. Compare accuracy,
accepted precision, coverage, class/language counts, and latency. Record hashes
of datasets, weights, configs, feature caches and frozen readout. Authored paired
cases remain correlated and cannot establish population-wide noninferiority.
If integration is justified, verify the plugin pipe matches frozen inference.

## Research

- [Official Laya tuning](https://github.com/NandhaKishorM/laya/blob/main/docs/finetune.md),
  source revision `6d942c92081fbc139e736bbd9ac0023223c29b7f`.
- [stuntd frozen encoder/head training](https://github.com/bladedevoff/stuntd/blob/main/stuntd/train/trainer.py),
  source revision `102a63116ef597231e3b2aa1455dea583e099cc0`, Apache 2.0.
  This experiment uses an independently implemented linear readout, not its
  transformer-head training code, proxy, or dependencies.

Upstream distinguishes calibration from label accuracy and holds calibration
cases out before training. This experiment follows those boundaries while
using MLX FP16 features from the exact Mac serving checkpoint.
