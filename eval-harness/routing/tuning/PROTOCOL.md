# Routing head training protocol

Decision, 2026-09-29: specialize Laya's frozen encoder for the four routing bands
with a small linear readout, then calibrate confidence on a separate slice.
Keep the shared routing rubric, disclosure checks and 0.8 gate unchanged.

Extract FP16 features from each pinned checkpoint using JSON `{"task": text}`
and the candidate's typed activity/category question. Reject token truncation.
Compare mean encoder state tokens, mean decision-head state tokens and
concatenated option markers. L2-normalize features and fit linear softmax heads
using mean cross entropy plus half the penalty times squared weights. Test
exactly 0.0001, 0.001, 0.01 and 0.1 penalties.

Use the 520 development cases with five folds, grouped by within-class/language
ordinal modulo five. This keeps the prompting dataset's translation pairs
together. Older sets are ordinal-grouped but not literal translations; thematic
overlap can cross folds. Treat cross-validation as a selection aid. Choose highest
accuracy, then lowest log loss, then declared checkpoint order. Refit on all 520
development cases. Use the separate 120 calibration cases for one temperature,
bounded to [0.1, 10]. Temperature changes confidence, never argmax. Three-tier
routing sums the middle two probabilities.

Freeze candidate, wording and selection before authoring/inference on a new
test. Retained tests have been inspected and are regression inputs. Report every
error, timeout and disclosure exclusion; no retries or selected-case omissions.
Compare the actual plugin pipe, JEV and Gemma on identical public synthetic
inputs and policy. Audit accuracy, accepted precision, coverage, language/class
counts and latency. Preserve run metadata locally and keep generated artifacts
out of Git. Promote the candidate and its generated runtime artifact together
only after verifying distributions and three/four-tier behavior.

Synthetic bilingual cases are correlated and their labels describe the rubric,
not downstream answer quality. Do not claim population-wide superiority from
these small tests. No private histories or credentials belong in training inputs.

Research references:

- [Official Laya tuning](https://github.com/NandhaKishorM/laya/blob/main/docs/finetune.md),
  revision `6d942c92081fbc139e736bbd9ac0023223c29b7f`.
- [stuntd frozen encoder/head training](https://github.com/bladedevoff/stuntd/blob/main/stuntd/train/trainer.py),
  revision `102a63116ef597231e3b2aa1455dea583e099cc0`, Apache 2.0.
  Its code, proxy and dependencies are not imported; the linear readout is local.
