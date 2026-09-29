# Checkpoint-specific correctness calibration

Frozen method, 2026-09-29, before new test inference. Scope: the three Laya checkpoints using their previously selected JSON choice variants. Do not change weights, questions, tier descriptions or predicted labels.

Repurpose the previously inspected 120-prompt alternatives holdout as calibration data. It is separate from the 200-prompt variant-development set but is no longer a holdout. Fit one monotone Platt map per checkpoint: `sigmoid(a * logit(p_max) + b)`, with `a` in [0.01,20], `b` in [-20,20], initialized at identity. Minimize mean binary negative log likelihood plus fixed L2 penalty `0.001*(a²+b²)` using L-BFGS-B. Clip inputs to [1e-6,1-1e-6] for the logit. The penalty/bounds are an evaluation design choice, not fitted hyperparameters. No method selection on new test results.

This estimates correctness of the selected tier; it does not produce a recalibrated four-class distribution. Positive slope preserves confidence ordering and all original tier choices. Report equivalent raw-score cutoffs so the coverage change is explicit. Fixed calibrated acceptance gates: 0.8 (primary, matching current policy) and 0.95 (secondary conservative comparison). No search for a favorable test threshold, and no guarantee of either accuracy target.

Freeze calibration coefficients before creating/running the new 120-prompt test. The new authored English/German test contains 15 prompts per tier/language and no exact overlap with either previous dataset. Same-author labels remain a limitation: this is not independent human annotation, real traffic or downstream capability ground truth.

Evaluate raw and calibrated confidence on identical predictions: coverage, correct/wrong accepted decisions, 95% Wilson intervals for accepted accuracy, binary correctness Brier score, binary NLL and fixed-bin ECE. Overall classification accuracy must stay identical. Include per-language results. No live config changes or automatic promotion.
