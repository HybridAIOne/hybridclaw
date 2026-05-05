"""Body-target evolution.

The body markdown is the optimizable text. A follower LM "executes" the
skill against tasks and an LLM-judge scores the outputs across three
dimensions. GEPA consumes the judge's textual feedback to propose
reflective mutations.
"""
from __future__ import annotations

from dataclasses import dataclass

import dspy

from skill_evolver.fitness.executor import TaskExample, score_body


@dataclass
class BodyRunResult:
    baseline_body: str
    best_body: str
    baseline_score: float
    best_score: float
    feedback_trail: list[str]


class BodyModule(dspy.Module):
    """Module whose optimizable parameter is the SKILL.md body."""

    def __init__(self, body: str):
        super().__init__()
        self.body = body

    def forward(self, **kwargs):  # pragma: no cover
        return dspy.Prediction(body=self.body)


def run(
    *,
    baseline_body: str,
    train_examples: list[TaskExample],
    val_examples: list[TaskExample],
    optimizer_model: str,
    eval_model: str,
    iterations: int,
    max_body_bytes: int,
) -> BodyRunResult:
    from gepa import GEPA

    baseline_score = score_body(
        body=baseline_body,
        tasks=val_examples or train_examples,
        eval_lm_name=eval_model,
        max_body_bytes=max_body_bytes,
    )

    candidate_pool = {"body": baseline_body}

    def evaluate(candidate, batch):
        body = candidate.get("body", baseline_body)
        score = score_body(
            body=body,
            tasks=batch,
            eval_lm_name=eval_model,
            max_body_bytes=max_body_bytes,
        )
        return [
            {"score": score.composite, "feedback": score.feedback}
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
        best_candidate = {"body": baseline_body, "_error": f"GEPA-body error: {err}"}

    best_body = best_candidate.get("body", baseline_body)
    best_score = score_body(
        body=best_body,
        tasks=val_examples or train_examples,
        eval_lm_name=eval_model,
        max_body_bytes=max_body_bytes,
    )

    return BodyRunResult(
        baseline_body=baseline_body,
        best_body=best_body,
        baseline_score=baseline_score.composite,
        best_score=best_score.composite,
        feedback_trail=[baseline_score.feedback, best_score.feedback],
    )
