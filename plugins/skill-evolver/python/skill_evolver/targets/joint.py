"""Joint target — evolve body, then description, then validate cross-impact.

Body first (contained change, doesn't affect routing). Then description
against frozen body. Finally re-score triggers with the new description
AND re-score body execution with the new description to detect any drift
caused by the description wording bleeding into how the body reads.
"""
from __future__ import annotations

from dataclasses import dataclass

from skill_evolver.fitness.classifier import TriggerExample, score_description
from skill_evolver.fitness.executor import TaskExample, score_body
from skill_evolver.targets import body as body_target
from skill_evolver.targets import description as description_target


@dataclass
class JointRunResult:
    baseline_description: str
    baseline_body: str
    best_description: str
    best_body: str
    description_baseline_score: float
    description_best_score: float
    body_baseline_score: float
    body_best_score: float
    feedback_trail: list[str]


def run(
    *,
    skill_name: str,
    baseline_description: str,
    baseline_body: str,
    trigger_train: list[TriggerExample],
    trigger_val: list[TriggerExample],
    task_train: list[TaskExample],
    task_val: list[TaskExample],
    optimizer_model: str,
    eval_model: str,
    iterations: int,
    max_body_bytes: int,
) -> JointRunResult:
    body_run = body_target.run(
        baseline_body=baseline_body,
        train_examples=task_train,
        val_examples=task_val,
        optimizer_model=optimizer_model,
        eval_model=eval_model,
        iterations=iterations,
        max_body_bytes=max_body_bytes,
    )
    desc_run = description_target.run(
        skill_name=skill_name,
        baseline_description=baseline_description,
        train_examples=trigger_train,
        val_examples=trigger_val,
        optimizer_model=optimizer_model,
        eval_model=eval_model,
        iterations=iterations,
    )

    body_with_new_description_score = score_body(
        body=body_run.best_body,
        tasks=task_val or task_train,
        eval_lm_name=eval_model,
        max_body_bytes=max_body_bytes,
    )
    desc_with_new_body_score = score_description(
        target_name=skill_name,
        target_description=desc_run.best_description,
        examples=trigger_val or trigger_train,
        eval_lm_name=eval_model,
    )

    feedback = [
        "== body evolution ==",
        *body_run.feedback_trail,
        "== description evolution ==",
        *desc_run.feedback_trail,
        "== joint re-validation ==",
        f"body with new description: {body_with_new_description_score.feedback}",
        f"description with new body (trigger pool unchanged): {desc_with_new_body_score.feedback}",
    ]

    return JointRunResult(
        baseline_description=baseline_description,
        baseline_body=baseline_body,
        best_description=desc_run.best_description,
        best_body=body_run.best_body,
        description_baseline_score=desc_run.baseline_score,
        description_best_score=desc_with_new_body_score.composite,
        body_baseline_score=body_run.baseline_score,
        body_best_score=body_with_new_description_score.composite,
        feedback_trail=feedback,
    )
