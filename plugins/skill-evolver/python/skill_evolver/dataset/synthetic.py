"""Synthetic dataset generation via LLM.

Produces two shapes:
- Trigger dataset: (prompt, should_trigger, competing_skills) for description eval
- Task dataset: (prompt, expected_behavior) for body eval

The generation prompt grounds the LLM in the current SKILL.md so the
synthetic data is realistic for the skill's actual purpose.
"""
from __future__ import annotations

import json
import re

import dspy

from skill_evolver.fitness.classifier import TriggerExample
from skill_evolver.fitness.executor import TaskExample


class GenerateTriggersSignature(dspy.Signature):
    """Generate evaluation prompts for a skill's trigger/routing accuracy.

    You will produce a JSON array of objects. Each object is either:
      {"prompt": "...", "should_trigger": true}   # clearly this skill's territory
      {"prompt": "...", "should_trigger": false}  # similar-sounding but NOT this skill

    Aim for 40% positive, 60% negative (including adversarial near-misses that
    a naive classifier might misroute). Make prompts realistic — how a user
    would actually phrase them, not test-case-flavored.

    Return ONLY the JSON array, no markdown fences.
    """
    skill_name: str = dspy.InputField()
    skill_description: str = dspy.InputField()
    skill_body_excerpt: str = dspy.InputField(desc="First ~1500 chars of SKILL.md body")
    competing_skills_context: str = dspy.InputField(
        desc="Short summaries of nearby/competing skills to avoid collision"
    )
    count: int = dspy.InputField(desc="Total number of prompts to generate")
    dataset_json: str = dspy.OutputField(desc="JSON array of {prompt, should_trigger}")


class GenerateTasksSignature(dspy.Signature):
    """Generate evaluation tasks for a skill's execution quality.

    Produce a JSON array of objects:
      {"prompt": "...", "expected_behavior": "..."}

    - prompt: a realistic user task this skill should handle
    - expected_behavior: a rubric paragraph describing what a correct response
      looks like — what the artifact should contain, what procedure should be
      followed, what to avoid. Detailed enough that an LLM-judge can score.

    Cover a range: easy / typical / hard / edge-case. Return ONLY the JSON array.
    """
    skill_name: str = dspy.InputField()
    skill_description: str = dspy.InputField()
    skill_body: str = dspy.InputField()
    count: int = dspy.InputField()
    dataset_json: str = dspy.OutputField()


def _parse_json_array(raw: str) -> list[dict]:
    raw = raw.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", raw, re.DOTALL)
    if fence:
        raw = fence.group(1).strip()
    start = raw.find("[")
    end = raw.rfind("]")
    if start < 0 or end < 0 or end <= start:
        return []
    try:
        parsed = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return []
    return [item for item in parsed if isinstance(item, dict)]


def generate_triggers(
    *,
    skill_name: str,
    skill_description: str,
    skill_body: str,
    competing_skills: list[dict],
    count: int,
    eval_lm_name: str,
) -> list[TriggerExample]:
    context = "\n".join(
        f"- {s['name']}: {s['description']}" for s in competing_skills[:12]
    ) or "(no adjacent skills provided)"
    excerpt = skill_body[:1500]

    generator = dspy.ChainOfThought(GenerateTriggersSignature)
    lm = dspy.LM(eval_lm_name)
    with dspy.context(lm=lm):
        result = generator(
            skill_name=skill_name,
            skill_description=skill_description,
            skill_body_excerpt=excerpt,
            competing_skills_context=context,
            count=count,
        )
    parsed = _parse_json_array(str(getattr(result, "dataset_json", "")))
    examples: list[TriggerExample] = []
    for item in parsed:
        prompt = str(item.get("prompt", "")).strip()
        if not prompt:
            continue
        should = bool(item.get("should_trigger", False))
        examples.append(
            TriggerExample(
                prompt=prompt,
                should_trigger=should,
                competing_skills=competing_skills,
            )
        )
    return examples


def generate_tasks(
    *,
    skill_name: str,
    skill_description: str,
    skill_body: str,
    count: int,
    eval_lm_name: str,
) -> list[TaskExample]:
    generator = dspy.ChainOfThought(GenerateTasksSignature)
    lm = dspy.LM(eval_lm_name)
    with dspy.context(lm=lm):
        result = generator(
            skill_name=skill_name,
            skill_description=skill_description,
            skill_body=skill_body[:6000],
            count=count,
        )
    parsed = _parse_json_array(str(getattr(result, "dataset_json", "")))
    examples: list[TaskExample] = []
    for item in parsed:
        prompt = str(item.get("prompt", "")).strip()
        expected = str(item.get("expected_behavior", "")).strip()
        if not prompt or not expected:
            continue
        examples.append(TaskExample(prompt=prompt, expected_behavior=expected))
    return examples
