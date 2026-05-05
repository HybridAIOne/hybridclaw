"""Golden dataset loader — hand-curated examples committed to the repo.

Layout under datasets/skills/<skill-name>/:
  triggers.json  — trigger-labeled prompts (description target)
  tasks.json     — task/rubric pairs (body target)

Both files are optional. If absent, the golden source contributes nothing.
"""
from __future__ import annotations

import json
from pathlib import Path

from skill_evolver.fitness.classifier import TriggerExample
from skill_evolver.fitness.executor import TaskExample


def load_triggers(
    datasets_dir: Path, skill_name: str, competing_skills: list[dict]
) -> list[TriggerExample]:
    path = datasets_dir / skill_name / "triggers.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    examples: list[TriggerExample] = []
    for item in data:
        if not isinstance(item, dict):
            continue
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


def load_tasks(datasets_dir: Path, skill_name: str) -> list[TaskExample]:
    path = datasets_dir / skill_name / "tasks.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    examples: list[TaskExample] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt", "")).strip()
        expected = str(item.get("expected_behavior", "")).strip()
        if not prompt or not expected:
            continue
        examples.append(TaskExample(prompt=prompt, expected_behavior=expected))
    return examples
