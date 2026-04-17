"""Description-target evolution.

Wraps the description field as an optimizable dspy.Module. GEPA mutates
the description; fitness is trigger-classification F1 against a labeled
prompt pool (competing skills included in the pool on every example).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import dspy

from skill_evolver.fitness.classifier import TriggerExample, score_description


@dataclass
class DescriptionRunResult:
    baseline_description: str
    best_description: str
    baseline_score: float
    best_score: float
    feedback_trail: list[str]


class DescriptionModule(dspy.Module):
    """A dspy.Module whose single optimizable parameter is the description text."""

    def __init__(self, description: str):
        super().__init__()
        self.description = description

    def forward(self, **kwargs):  # pragma: no cover - unused during GEPA text-mode optimization
        return dspy.Prediction(description=self.description)


def build_trigger_metric(
    skill_name: str,
    examples: list[TriggerExample],
    eval_lm_name: str,
) -> Callable:
    def metric(example, prediction, trace=None):
        description = getattr(prediction, "description", None) or getattr(
            example, "description", None
        )
        if not description:
            return dspy.Prediction(score=0.0, feedback="no description provided")
        score = score_description(
            target_name=skill_name,
            target_description=description,
            examples=examples,
            eval_lm_name=eval_lm_name,
        )
        return dspy.Prediction(score=score.composite, feedback=score.feedback)

    return metric


def run(
    *,
    skill_name: str,
    baseline_description: str,
    train_examples: list[TriggerExample],
    val_examples: list[TriggerExample],
    optimizer_model: str,
    eval_model: str,
    iterations: int,
) -> DescriptionRunResult:
    from gepa import GEPA  # Import inside function so import errors surface clearly.

    baseline_score_detail = score_description(
        target_name=skill_name,
        target_description=baseline_description,
        examples=val_examples or train_examples,
        eval_lm_name=eval_model,
    )

    candidate_pool = {"description": baseline_description}

    def evaluate(candidate, batch):
        description = candidate.get("description", baseline_description)
        result = score_description(
            target_name=skill_name,
            target_description=description,
            examples=batch,
            eval_lm_name=eval_model,
        )
        return [
            {
                "score": result.composite,
                "feedback": result.feedback,
            }
            for _ in batch or [None]
        ][: max(1, len(batch))]

    try:
        optimizer = GEPA(
            adapter=None,
            seed_candidate=candidate_pool,
            trainset=train_examples,
            valset=val_examples or train_examples,
            task_lm=eval_model,
            reflection_lm=optimizer_model,
            max_metric_calls=max(1, iterations) * max(1, len(train_examples)),
            evaluator=evaluate,
        )
        result = optimizer.optimize()
        best_candidate = getattr(result, "best_candidate", None) or candidate_pool
    except Exception as err:
        best_candidate = {
            "description": baseline_description,
            "_error": f"GEPA-description error: {err}",
        }

    best_description = best_candidate.get("description", baseline_description)
    best_score_detail = score_description(
        target_name=skill_name,
        target_description=best_description,
        examples=val_examples or train_examples,
        eval_lm_name=eval_model,
    )

    return DescriptionRunResult(
        baseline_description=baseline_description,
        best_description=best_description,
        baseline_score=baseline_score_detail.composite,
        best_score=best_score_detail.composite,
        feedback_trail=[baseline_score_detail.feedback, best_score_detail.feedback],
    )
