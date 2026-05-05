"""Trigger-classifier fitness for the description target.

Given a pool of competing skill descriptions, does the evolved description
cause the correct skill to fire on labeled prompts?
"""
from __future__ import annotations

from dataclasses import dataclass

import dspy


@dataclass
class TriggerExample:
    prompt: str
    should_trigger: bool
    competing_skills: list[dict]


@dataclass
class ClassifierScore:
    precision: float
    recall: float
    f1: float
    accuracy: float
    feedback: str
    correct_count: int
    total_count: int

    @property
    def composite(self) -> float:
        return self.f1


class SkillRouterSignature(dspy.Signature):
    """Route a user prompt to the most appropriate skill (or none).

    You are choosing which skill should handle a user's prompt from a
    numbered list. Return the number of the most appropriate skill, or 0
    if none of them is a clear match.

    Prefer 0 (no match) over forcing a match when the prompt is clearly
    outside every skill's scope.
    """
    user_prompt: str = dspy.InputField(desc="The user's request")
    skills_list: str = dspy.InputField(
        desc="Numbered list of candidate skills with their descriptions"
    )
    chosen_index: int = dspy.OutputField(
        desc="Integer index of the chosen skill, or 0 for no match"
    )
    reasoning: str = dspy.OutputField(
        desc="One sentence explaining the routing decision"
    )


def _format_skill_pool(
    target_name: str,
    target_description: str,
    competing: list[dict],
) -> tuple[str, int]:
    entries = [
        {"name": target_name, "description": target_description},
        *competing,
    ]
    # Stable order for reproducibility; randomize in caller if desired.
    lines = []
    target_index = 1
    for idx, skill in enumerate(entries, start=1):
        if skill["name"] == target_name:
            target_index = idx
        lines.append(f"{idx}. {skill['name']} — {skill['description']}")
    return "\n".join(lines), target_index


def score_description(
    *,
    target_name: str,
    target_description: str,
    examples: list[TriggerExample],
    eval_lm_name: str,
) -> ClassifierScore:
    if not examples:
        return ClassifierScore(
            precision=0.0,
            recall=0.0,
            f1=0.0,
            accuracy=0.0,
            feedback="No trigger examples provided — cannot score description.",
            correct_count=0,
            total_count=0,
        )
    router = dspy.ChainOfThought(SkillRouterSignature)
    lm = dspy.LM(eval_lm_name)

    tp = fp = fn = tn = 0
    failure_notes: list[str] = []

    with dspy.context(lm=lm):
        for example in examples:
            pool_text, target_idx = _format_skill_pool(
                target_name, target_description, example.competing_skills
            )
            try:
                prediction = router(
                    user_prompt=example.prompt,
                    skills_list=pool_text,
                )
                chosen = int(getattr(prediction, "chosen_index", 0) or 0)
                reasoning = str(getattr(prediction, "reasoning", ""))[:200]
            except Exception as err:  # pragma: no cover - LM faults are reported, not raised
                chosen = 0
                reasoning = f"router_error: {err}"

            triggered = chosen == target_idx
            if example.should_trigger and triggered:
                tp += 1
            elif example.should_trigger and not triggered:
                fn += 1
                failure_notes.append(
                    f"MISSED TRIGGER — prompt={example.prompt!r} chose={chosen} ({reasoning})"
                )
            elif not example.should_trigger and triggered:
                fp += 1
                failure_notes.append(
                    f"OVER-TRIGGERED — prompt={example.prompt!r} ({reasoning})"
                )
            else:
                tn += 1

    total = tp + fp + fn + tn
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (
        (2 * precision * recall) / (precision + recall)
        if (precision + recall) > 0
        else 0.0
    )
    accuracy = (tp + tn) / total if total > 0 else 0.0

    feedback_lines = [
        f"Trigger F1={f1:.3f} (precision={precision:.3f}, recall={recall:.3f}, accuracy={accuracy:.3f})",
        f"TP={tp} FP={fp} FN={fn} TN={tn}",
    ]
    feedback_lines.extend(failure_notes[:8])
    if len(failure_notes) > 8:
        feedback_lines.append(f"... and {len(failure_notes) - 8} more failures.")

    return ClassifierScore(
        precision=precision,
        recall=recall,
        f1=f1,
        accuracy=accuracy,
        feedback="\n".join(feedback_lines),
        correct_count=tp + tn,
        total_count=total,
    )
