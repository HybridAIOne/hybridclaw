# Frozen routing comparison design

Declared before inference, 2026-09-29. Existing 200 authored prompts are development data. `holdout.json` contains 120 newly authored prompts, 15 per tier/language, fixed before inference (SHA-256 `061eb2a8c62152a21f1a44f5426d6fde06e9c8d853b9e388440af9be980eaf75`). No exact prompt overlap or private session text. This is a same-author rubric holdout, not independently adjudicated downstream capability ground truth.

For jeff and GLiClass, compare raw/JSON task state with the three existing question wordings: difficulty, category, capability. For Horizon's NLI interface, compare raw/JSON state with three hypothesis templates: about, requires, difficulty. All six variants use the same four tier descriptions from the recorded production baseline. Highest correct count on development selects one per model, with ties resolved by declared order. No variant or label changes after held-out inference.

Laya baselines use the best previously observed choice variants for each checkpoint: JSON/difficulty for multilingual; JSON/capability for English and typed-decisions. These selections are based on the earlier 20-variant development experiments. Score variants are excluded from this four-way choice comparison.

Use jeff's upstream normalized sigmoid scores and default temperature 3.2, GLiClass single-label softmax, Horizon's standard exclusive NLI entailment softmax across candidates, and Laya's native option probabilities. Report 0.8-gate coverage and wrong accepted decisions; equal thresholds do not imply equally calibrated probabilities. No temperatures or thresholds are fitted on the holdout. No generative output or tool execution.

Run serial local inference, one model at a time. Prefer MPS for PyTorch models and MLX for Laya. Explicitly document CPU fallback if MPS fails. Exclude model loading and one fixed development warmup, synchronize GPU before/after timing. Errors count wrong, with an abort after three consecutive failures. Smoke cases are development-only. Do not promote a winner to live routing automatically.

JEV and Gemma retain their existing production routing prompts and configured timeout/gate as fixed held-out references, without development tuning. Only synthetic public prompts are submitted. Gemma's label-only path has no comparable native confidence score. Reference API timing is reported separately from direct local timing.

Development-only runtime correction: GLiClass initially inherited BF16 from its checkpoint configuration. The completed initial sweep had 39/1,200 distributions outside the sum tolerance; a nine-case CPU diagnostic reproduced BF16 rounding. Preserve that sweep under `results/gliclass-bf16-diagnostic/`, then repeat all six variants with explicit FP32 before selection. This changes numerical precision, not prompts, labels, temperatures or acceptance thresholds. jeff and Horizon also explicitly load FP32.
