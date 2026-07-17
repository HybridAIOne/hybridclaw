---
title: HybridRouter — SFT/PEFT Fine-Tuning Roadmap
description: Training roadmap for the learned entry-rung classifier (Qwen3.5-0.8B base) that upgrades the deterministic tier ladder's first guess. Companion to model-routing.md Phase 4 — the ladder works without it; this makes it sharper.
---

> **Internal document.** Companion to [model-routing.md](./model-routing.md) (§7 Phase 4). The deterministic ladder is the product; HybridRouter is the optimization that learns the entry rung. Nothing here is a dependency of Phases 0–3. Drafted 2026-07-17.

# HybridRouter — SFT/PEFT fine-tuning roadmap

## 1. Base model: Qwen3.5-0.8B

Verified 2026-07-17: released 2026-03-02 under **Apache-2.0** (unrestricted commercial use — no license clock ticking, unlike the LFM Open License), 0.8B params, **262K native context**, Gated-DeltaNet hybrid architecture (3:1 linear-to-full attention — fast prefill on long turn context, which is exactly the router's read pattern), **vision-language input** (future option: routing browser-skill turns that carry screenshots), fine-tuning supported across Axolotl / Unsloth / Swift / LLaMA-Factory (SFT, DPO, GRPO). Same size class ACRouter validated for routing (their router is a Qwen3.5-0.8B LoRA). Family scales 0.8B → 2B → 4B → 9B on the same recipe if the small model's ceiling is ever measured, not assumed. Fallback base: LFM2.5-350M/700M (pending LFM Open License commercial-terms check).

## 2. Design decisions (settled up front, hard to change later)

**D1 — Classifier, not generator.** In-house evidence: LFM-class models needed `<|tool_call_start|>` prefix forcing to emit structured output — tiny models are format-brittle in generation, solid as scorers. HybridRouter is a sequence-classification head (ordinal logits over rungs + task-class logits), no JSON parsing on the hot path. A constrained-generative variant (single-token label) is kept only as a serving-compat fallback.

**D2 — Predict task classes, never models (the Arch-Router lesson).** [Arch-Router](https://arxiv.org/html/2506.16655v1) (Katanemo, 1.5B) routes to human-readable *policy labels* and leaves label→model binding as config — so adding or swapping models requires **no retraining**. HybridRouter does the same one level down: it predicts `(task_class, min_rung)` where rungs are the ladder's *positions*, and tier→model binding stays operator config. A model swap, a tier re-bind, or new hardware never invalidates the router — the same property the tier aliases give the rest of the design.

**D3 — Calibrated and conservative.** Output probabilities are temperature-scaled on a held-out split; below a confidence threshold the router abstains and the deterministic taxonomy decides. Expected-calibration-error is a promotion gate, not a nice-to-have — an overconfident router silently routes hard work cheap, which is the one failure mode the ladder can't always catch.

**D4 — Sovereign pipeline end to end.** Corpora are R4-masked before persisting, splits are per-tenant, training runs on our fleet, adapters serve on our fleet. "The router learns your workload and none of it leaves" is a sales sentence only if the pipeline actually enforces it.

## 3. Data roadmap

| Stage | Source | Label | Status/dependency |
|---|---|---|---|
| **D0 telemetry** | production `route.decided/escalated` + verifier outcomes (Phase 1 events) | partial: every escalation = "entry rung too low"; every un-escalated success = "rung sufficient (upper bound unknown)" | free from Phase 1 day one |
| **D1 replay** | logged turns re-run through **all** tiers on haigpu1/2, scored by the same deterministic verifiers + F11 judge | full: `min_rung` = lowest rung that passes verification — closes the censoring problem (a frontier success never reveals whether standard sufficed) | needs Phase 2 verifiers; marginal cost ≈ electricity on own fleet — API-bound competitors pay list price for this matrix |
| **D2 synthetic cold-start** | frontier model generates task variants per skill (difficulty ladders, paraphrases); tiers run them; verifiers label | same `min_rung` schema | Arch-Router trained on *purely* synthetic data and beat proprietary LLMs by 7.71% — validates this path for new skills/tenants with zero history |
| **D3 continuous** | per-tenant trickle of D0+D1, versioned | — | steady state; feeds T3 adapter refreshes |

**Example record (JSONL):**

```jsonc
{ "features": { "origin": "channel", "skill": "datev-export", "agent": "buchhaltung", 
    "thread_depth": 7, "has_tool_result": true, "stakes": "low", "sensitivity": "internal" },
  "text": "<R4-masked turn content, truncated to budget>",
  "task_class": "structured_extraction",
  "min_rung": 1,                       // 0=small 1=standard 2=frontier (ladder positions, not models)
  "provenance": { "kind": "replay", "run": "hcrb-2026-07", "verifier": "schema+judge" } }
```

**Split discipline:** split by *session and tenant*, never by turn — turns within a session leak. Holdout = the HC-RouteBench replay set; it doubles as the promotion gate. Class balance: `min_rung` skews heavily toward 0/1 (that's the point of the business); use class weights, report per-class recall — recall on rung-2 ("genuinely hard") is the metric that protects quality.

**Volumes:** hundreds of labels train the T0 logistic baseline; low thousands per domain train T1 LoRA; D1 replay manufactures 10k+ labels from one batch overnight.

## 4. Training roadmap

**T0 — baseline without training (1–2 days).** Frozen embeddings (in-repo substrate) + deterministic features → logistic/GBM head → `min_rung`. Ships as a coefficient file, ~1 ms CPU, fully interpretable. **T0 is the bar every later stage must beat on HC-RouteBench — if LoRA doesn't beat logistic regression, we ship logistic regression.**

**T1 — LoRA SFT (first real fine-tune).** Unsloth/TRL (or LLaMA-Factory) on Qwen3.5-0.8B with a classification head. Starting hyperparameters (to be swept, not trusted): r=16–32, α=2r, lr 1–2e-4 cosine, 2–3 epochs, seq len 2–4k (truncate turn text, keep features verbatim), bf16 — trains comfortably on one 5090-class card in hours. Full fine-tune is feasible at 0.8B but LoRA is preferred: per-tenant adapters (T3) need the shared frozen base.

**T2 — ordinal loss + calibration + teacher distillation.** Replace plain CE with an ordinal objective (cumulative-logits/CORN — misrouting by two rungs must cost more than by one); temperature-scale on validation; for turns where verifiers disagree or the judge is uncertain, distill soft labels from a frontier-model teacher pass (cheap: only the ambiguous slice).

**T3 — per-tenant adapters.** One shared base + per-tenant LoRA, hot-swapped at inference (S-LoRA/Lorax-style multi-adapter serving is mature in vLLM — thousands of adapters per GPU). Tenant adapter trains on D3 trickle; falls back to the global adapter below a data threshold. This is the "router calibrated to your workload" plan-differentiator.

**T4 — optional preference/RL stage.** GRPO on a regret signal (chosen rung vs. replay-optimal rung), only if T1–T3 plateau measurably below the deterministic-plus-scoreboard alternative. Not scheduled until then — every stage before this is supervised and debuggable.

## 5. Evaluation & promotion gates

A router version ships only through, in order: **(1)** HC-RouteBench replay — cumulative regret, blended-cost-at-quality, predicted-vs-actual escalation-rate delta; **(2)** calibration — ECE under threshold, per-class recall floor on rung 2; **(3)** latency — ≤10 ms p99 on haigpu2 GPU / ≤40 ms CPU-ONNX, else it doesn't ride the hot path; **(4)** R16 canary on a traffic slice with the savings dashboard watched; **(5)** rollback — weights are F4-versioned (the roadmap's F4 already covers "classifier weights"), and the kill switch degrades to the deterministic ladder, never to nothing.

## 6. Serving

Primary: vLLM on haigpu2, classification task, multi-LoRA enabled (tenant adapters hot-swap; adapter-load latency hides behind first layers). Standalone/OSS gateways without a GPU: ONNX INT8 export of base+merged-global-adapter on CPU. The router abstains on timeout — the ladder never waits on it.

## 7. Sequence & effort

| Step | Depends on | Effort |
|---|---|---|
| D0 events + T0 baseline | model-routing Phase 1 | days |
| D1 replay harness (doubles as HC-RouteBench) | Phase 2 verifiers | ~1 week |
| T1 LoRA + gates | D1 | ~1 week incl. sweep |
| T2 ordinal + calibration | T1 | days |
| D2 synthetic + T3 tenant adapters | T1 stable | 1–2 weeks |
| T4 GRPO | proven plateau | not scheduled |

## 8. References

[Qwen3.5 release/specs](https://llm-stats.com/models/qwen3.5-0.8b) · [Unsloth LFM/Qwen tutorials](https://unsloth.ai/docs/models/tutorials/lfm2.5) · [Arch-Router paper](https://arxiv.org/html/2506.16655v1) + [model](https://huggingface.co/katanemo/Arch-Router-1.5B) · [ACRouter](https://github.com/LanceZPF/agent-as-a-router) (replay-bench + verifier-escalation) · [RouteLLM](https://github.com/lm-sys/RouteLLM) (preference-label recipes) · [Routing/cascading survey 2026](https://arxiv.org/pdf/2603.04445) · [S-LoRA](https://arxiv.org/pdf/2311.03285) (multi-adapter serving).
