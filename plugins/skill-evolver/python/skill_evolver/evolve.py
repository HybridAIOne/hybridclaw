"""Top-level evolution orchestrator.

Loads a SKILL.md, builds the dataset from three sources, runs the chosen
target's GEPA loop, validates constraints, and writes a result.json that
the TS plugin consumes to decide whether to open a PR.
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

import dspy

from skill_evolver import constraints
from skill_evolver.dataset import golden, merge, synthetic, traces
from skill_evolver.skill_module import ParsedSkill, load_skill, reassemble
from skill_evolver.targets import body as body_target
from skill_evolver.targets import description as description_target
from skill_evolver.targets import joint as joint_target


@dataclass
class EvolveConfig:
    skill_path: Path
    skill_name: str
    target: str
    sources: list[str]
    iterations: int
    optimizer_model: str
    eval_model: str
    max_body_bytes: int
    max_description_chars: int
    repo_root: Path
    datasets_dir: Path
    work_dir: Path
    traces_dataset_path: Optional[Path]
    dry_run: bool


def _collect_competing_skills(
    repo_root: Path, target_skill: ParsedSkill, max_count: int = 40
) -> list[dict]:
    search_roots = ["skills", "community-skills", "plugins"]
    skills: list[dict] = []
    for rel in search_roots:
        root = repo_root / rel
        if not root.exists():
            continue
        for skill_md in root.rglob("SKILL.md"):
            if skill_md == target_skill.path:
                continue
            try:
                parsed = load_skill(skill_md)
            except Exception:
                continue
            if not parsed.description:
                continue
            skills.append({"name": parsed.name, "description": parsed.description})
            if len(skills) >= max_count:
                return skills
    return skills


def _configure_dspy(eval_model: str) -> None:
    try:
        lm = dspy.LM(eval_model)
        dspy.configure(lm=lm)
    except Exception:
        pass


def _build_trigger_dataset(
    config: EvolveConfig, skill: ParsedSkill, competing: list[dict]
):
    combined = []
    if "synthetic" in config.sources:
        combined.extend(
            synthetic.generate_triggers(
                skill_name=skill.name,
                skill_description=skill.description,
                skill_body=skill.body,
                competing_skills=competing,
                count=40,
                eval_lm_name=config.eval_model,
            )
        )
    if "golden" in config.sources:
        combined.extend(golden.load_triggers(config.datasets_dir, skill.name, competing))
    if "traces" in config.sources and config.traces_dataset_path:
        payload = traces.load_trace_payload(config.traces_dataset_path)
        combined.extend(traces.build_triggers(payload, competing))
    deduped = merge.dedupe_triggers(combined)
    return merge.split_triggers(deduped)


def _build_task_dataset(config: EvolveConfig, skill: ParsedSkill):
    combined = []
    if "synthetic" in config.sources:
        combined.extend(
            synthetic.generate_tasks(
                skill_name=skill.name,
                skill_description=skill.description,
                skill_body=skill.body,
                count=20,
                eval_lm_name=config.eval_model,
            )
        )
    if "golden" in config.sources:
        combined.extend(golden.load_tasks(config.datasets_dir, skill.name))
    if "traces" in config.sources and config.traces_dataset_path:
        payload = traces.load_trace_payload(config.traces_dataset_path)
        combined.extend(
            traces.build_tasks(
                payload,
                skill_name=skill.name,
                skill_description=skill.description,
                eval_lm_name=config.eval_model,
            )
        )
    deduped = merge.dedupe_tasks(combined)
    return merge.split_tasks(deduped)


def _validate_variant(
    *,
    target: str,
    baseline: ParsedSkill,
    description: str,
    body: str,
    max_body_bytes: int,
    max_description_chars: int,
) -> list[constraints.ConstraintResult]:
    results: list[constraints.ConstraintResult] = []
    if target in ("description", "both"):
        results.extend(
            constraints.validate_description(
                description, max_chars=max_description_chars
            )
        )
    if target in ("body", "both"):
        results.extend(
            constraints.validate_body(
                body, baseline_body=baseline.body, max_bytes=max_body_bytes
            )
        )
    return results


def run(config: EvolveConfig) -> dict:
    config.work_dir.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex[:12]
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    _configure_dspy(config.eval_model)

    skill = load_skill(config.skill_path)
    competing = _collect_competing_skills(config.repo_root, skill)

    result: dict = {
        "runId": run_id,
        "startedAt": started_at,
        "skillName": skill.name,
        "skillPath": str(skill.path),
        "target": config.target,
        "sources": config.sources,
        "iterations": config.iterations,
        "baseline": skill.describe(),
        "competingSkillCount": len(competing),
    }

    if config.dry_run:
        result["dryRun"] = True
        (config.work_dir / "result.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8"
        )
        return result

    trigger_split = None
    task_split = None

    if config.target in ("description", "both"):
        trigger_split = _build_trigger_dataset(config, skill, competing)
        result["triggerDataset"] = {
            "train": len(trigger_split.train),
            "val": len(trigger_split.val),
        }
    if config.target in ("body", "both"):
        task_split = _build_task_dataset(config, skill)
        result["taskDataset"] = {
            "train": len(task_split.train),
            "val": len(task_split.val),
        }

    best_description = skill.description
    best_body = skill.body
    feedback_trail: list[str] = []

    if config.target == "description" and trigger_split:
        run_result = description_target.run(
            skill_name=skill.name,
            baseline_description=skill.description,
            train_examples=trigger_split.train,
            val_examples=trigger_split.val,
            optimizer_model=config.optimizer_model,
            eval_model=config.eval_model,
            iterations=config.iterations,
        )
        best_description = run_result.best_description
        feedback_trail = run_result.feedback_trail
        result["descriptionScore"] = {
            "baseline": run_result.baseline_score,
            "best": run_result.best_score,
        }
    elif config.target == "body" and task_split:
        run_result = body_target.run(
            baseline_body=skill.body,
            train_examples=task_split.train,
            val_examples=task_split.val,
            optimizer_model=config.optimizer_model,
            eval_model=config.eval_model,
            iterations=config.iterations,
            max_body_bytes=config.max_body_bytes,
        )
        best_body = run_result.best_body
        feedback_trail = run_result.feedback_trail
        result["bodyScore"] = {
            "baseline": run_result.baseline_score,
            "best": run_result.best_score,
        }
    elif config.target == "both" and trigger_split and task_split:
        run_result = joint_target.run(
            skill_name=skill.name,
            baseline_description=skill.description,
            baseline_body=skill.body,
            trigger_train=trigger_split.train,
            trigger_val=trigger_split.val,
            task_train=task_split.train,
            task_val=task_split.val,
            optimizer_model=config.optimizer_model,
            eval_model=config.eval_model,
            iterations=config.iterations,
            max_body_bytes=config.max_body_bytes,
        )
        best_description = run_result.best_description
        best_body = run_result.best_body
        feedback_trail = run_result.feedback_trail
        result["descriptionScore"] = {
            "baseline": run_result.description_baseline_score,
            "best": run_result.description_best_score,
        }
        result["bodyScore"] = {
            "baseline": run_result.body_baseline_score,
            "best": run_result.body_best_score,
        }
    else:
        result["error"] = (
            f"target={config.target} requires the relevant dataset shape, which is empty."
        )
        (config.work_dir / "result.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8"
        )
        return result

    validation = _validate_variant(
        target=config.target,
        baseline=skill,
        description=best_description,
        body=best_body,
        max_body_bytes=config.max_body_bytes,
        max_description_chars=config.max_description_chars,
    )
    result["constraints"] = [
        {"name": r.name, "passed": r.passed, "message": r.message} for r in validation
    ]

    best_variant_raw = None
    if constraints.all_passed(validation):
        best_variant_raw = reassemble(
            skill,
            description=best_description if config.target != "body" else None,
            body=best_body if config.target != "description" else None,
        )
        result["bestVariantRaw"] = best_variant_raw
        result["applicable"] = True
    else:
        result["applicable"] = False

    result["feedbackTrail"] = feedback_trail
    result["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    from skill_evolver.report import render_report_markdown

    result["reportMarkdown"] = render_report_markdown(skill, result)

    (config.work_dir / "result.json").write_text(
        json.dumps(result, indent=2), encoding="utf-8"
    )
    return result
