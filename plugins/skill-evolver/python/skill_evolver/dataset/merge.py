"""Combine the three dataset sources into train/val splits.

Deduplicates by normalized prompt. Ensures a minimum size per split so GEPA
has something to evaluate against.
"""
from __future__ import annotations

import random
import re
from dataclasses import dataclass

from skill_evolver.fitness.classifier import TriggerExample
from skill_evolver.fitness.executor import TaskExample


def _normalize(prompt: str) -> str:
    return re.sub(r"\s+", " ", prompt.strip().lower())


@dataclass
class TriggerSplit:
    train: list[TriggerExample]
    val: list[TriggerExample]


@dataclass
class TaskSplit:
    train: list[TaskExample]
    val: list[TaskExample]


def dedupe_triggers(examples: list[TriggerExample]) -> list[TriggerExample]:
    seen: set[str] = set()
    deduped: list[TriggerExample] = []
    for ex in examples:
        key = _normalize(ex.prompt)
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(ex)
    return deduped


def dedupe_tasks(examples: list[TaskExample]) -> list[TaskExample]:
    seen: set[str] = set()
    deduped: list[TaskExample] = []
    for ex in examples:
        key = _normalize(ex.prompt)
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(ex)
    return deduped


def split_triggers(
    examples: list[TriggerExample], *, val_fraction: float = 0.25, seed: int = 42
) -> TriggerSplit:
    rng = random.Random(seed)
    shuffled = examples[:]
    rng.shuffle(shuffled)
    positives = [ex for ex in shuffled if ex.should_trigger]
    negatives = [ex for ex in shuffled if not ex.should_trigger]
    pos_val = max(1, int(len(positives) * val_fraction)) if positives else 0
    neg_val = max(1, int(len(negatives) * val_fraction)) if negatives else 0
    val = positives[:pos_val] + negatives[:neg_val]
    train = positives[pos_val:] + negatives[neg_val:]
    rng.shuffle(val)
    rng.shuffle(train)
    return TriggerSplit(train=train, val=val)


def split_tasks(
    examples: list[TaskExample], *, val_fraction: float = 0.25, seed: int = 42
) -> TaskSplit:
    rng = random.Random(seed)
    shuffled = examples[:]
    rng.shuffle(shuffled)
    val_size = max(1, int(len(shuffled) * val_fraction)) if shuffled else 0
    return TaskSplit(train=shuffled[val_size:], val=shuffled[:val_size])
