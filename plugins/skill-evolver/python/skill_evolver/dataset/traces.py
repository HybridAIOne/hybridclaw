"""Trace-based dataset construction from HybridClaw's sqlite observations.

Consumes the JSON file produced by the TS trace-extractor. Two products:

- Triggers: user prompts that DID invoke this skill (positives) plus prompts
  that invoked other skills (negatives). These need a rubric the classifier
  trusts — we treat successful invocations as positives and near-miss sibling
  invocations as negatives.

- Tasks: user prompts that successfully invoked this skill, paired with an
  LLM-synthesized rubric describing what a correct response looks like, given
  the observed outcome. Failed observations become harder test cases.
"""
from __future__ import annotations

import json
from pathlib import Path

import dspy

from skill_evolver.fitness.classifier import TriggerExample
from skill_evolver.fitness.executor import TaskExample


class SynthesizeRubricSignature(dspy.Signature):
    """Given a user prompt and observed outcome, write a rubric for a judge.

    The rubric should describe what a good response to the prompt looks like —
    concrete artifacts, structure, procedure. If the trace shows a failure,
    make the rubric address that specific failure mode (e.g. "must not …",
    "must correctly handle …").
    """
    skill_name: str = dspy.InputField()
    skill_description: str = dspy.InputField()
    user_prompt: str = dspy.InputField()
    outcome: str = dspy.InputField(desc="success/partial/failure")
    error_category: str = dspy.InputField()
    error_detail: str = dspy.InputField()
    rubric: str = dspy.OutputField(desc="1-paragraph rubric for an LLM-judge")


def load_trace_payload(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def build_triggers(
    payload: dict, competing_skills: list[dict]
) -> list[TriggerExample]:
    examples: list[TriggerExample] = []
    for obs in payload.get("observations", []):
        prompt = str(obs.get("user_prompt", "")).strip()
        if not prompt:
            continue
        if obs.get("outcome") == "success":
            examples.append(
                TriggerExample(
                    prompt=prompt, should_trigger=True, competing_skills=competing_skills
                )
            )
    for obs in payload.get("otherSkillObservations", []):
        prompt = str(obs.get("user_prompt", "")).strip()
        if not prompt:
            continue
        examples.append(
            TriggerExample(
                prompt=prompt, should_trigger=False, competing_skills=competing_skills
            )
        )
    return examples


def build_tasks(
    payload: dict,
    *,
    skill_name: str,
    skill_description: str,
    eval_lm_name: str,
    max_examples: int = 40,
) -> list[TaskExample]:
    observations = payload.get("observations", [])
    observations = [o for o in observations if str(o.get("user_prompt", "")).strip()]

    prioritized = sorted(
        observations,
        key=lambda o: (0 if o.get("outcome") != "success" else 1, o.get("created_at", "")),
    )[:max_examples]
    if not prioritized:
        return []

    rubric_gen = dspy.ChainOfThought(SynthesizeRubricSignature)
    lm = dspy.LM(eval_lm_name)
    examples: list[TaskExample] = []
    with dspy.context(lm=lm):
        for obs in prioritized:
            try:
                result = rubric_gen(
                    skill_name=skill_name,
                    skill_description=skill_description,
                    user_prompt=obs["user_prompt"],
                    outcome=str(obs.get("outcome", "")),
                    error_category=str(obs.get("error_category") or ""),
                    error_detail=str(obs.get("error_detail") or "")[:600],
                )
                rubric = str(getattr(result, "rubric", "")).strip()
            except Exception:  # pragma: no cover
                rubric = ""
            if not rubric:
                continue
            examples.append(
                TaskExample(prompt=obs["user_prompt"], expected_behavior=rubric)
            )
    return examples
