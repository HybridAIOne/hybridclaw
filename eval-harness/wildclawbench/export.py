"""Export only complete, billed 60-task runs; absent scores retain zero weight."""

import argparse
from collections import defaultdict
from datetime import date
import json
import math
from pathlib import Path
import subprocess


HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / "manifest.json").read_text())
MODELS = MANIFEST["models"]


def export_run(summary, model, categories, expected_tasks, run_date):
    rows = summary["results"]
    if summary["task_count"] != 60 or len(rows) != 60:
        raise ValueError("A comparable run must contain all 60 tasks")
    # Upstream adds model, timestamp and UUID after the short task identity.
    task_keys = ["_".join(row["task_id"].split("_")[:3]) for row in rows]
    if len(set(task_keys)) != 60 or set(task_keys) != expected_tasks:
        raise ValueError("Task identities differ from the pinned 60-task suite")
    groups = defaultdict(list)
    costs, minutes = [], []
    failed = 0
    provenance = None
    for row in rows:
        usage = row.get("usage", {})
        if usage.get("accounting_complete") is not True:
            raise ValueError("Incomplete billing; results cannot be published")
        recorded = usage.get("provenance", {})
        identity = {key: recorded.get(key) for key in
                    ("hybridclaw_commit", "hybridclaw_version", "image_id")}
        if any(not value for value in identity.values()):
            raise ValueError("Missing image/source provenance")
        if provenance is not None and identity != provenance:
            raise ValueError("Mixed image/source revisions cannot form one model run")
        provenance = identity
        cost = usage["cost_usd"]
        elapsed = usage["elapsed_time"]
        if any(not isinstance(n, (int, float)) or not math.isfinite(n) or n < 0
               for n in (cost, elapsed)):
            raise ValueError("Invalid task cost or elapsed time")
        scores = row.get("scores") or {}
        numeric = [v for v in scores.values() if isinstance(v, (int, float))]
        score = scores.get("overall_score", sum(numeric) / len(numeric) if numeric else 0)
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("Invalid task score")
        category = categories[row["task_id"].split("_", 1)[0]]
        groups[category].append(score)
        failed += bool(row.get("error") or scores.get("error") or scores.get("judge_error") or not numeric)
        costs.append(cost)
        minutes.append(elapsed / 60)
    average = sum(sum(v) for v in groups.values()) / 60
    if not math.isclose(average, summary["global_avg"], abs_tol=1e-9):
        raise ValueError("Computed score disagrees with the upstream global summary")
    return {
        "agent": "hybridclaw", "model": MODELS[model], "benchmark": "wildclawbench",
        "score": round(average * 100, 4), "usd_per_task": sum(costs) / 60,
        "minutes_per_task": sum(minutes) / 60, "tasks": 60, "failed_infra": failed,
        "per_category": {k: round(sum(v) / len(v) * 100, 4) for k, v in sorted(groups.items())},
        "wildclawbench_commit": MANIFEST["wildclawbench_commit"],
        **provenance,
        "hybridclaw_baseline_commit": MANIFEST["hybridclaw_commit"],
        "source_variant": "baseline" if provenance["hybridclaw_commit"] == MANIFEST["hybridclaw_commit"] else "patched",
        "judge_model": "openai/gpt-5.4", "run_date": run_date,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("benchmark", type=Path)
    parser.add_argument("--run-date", required=True, type=lambda s: date.fromisoformat(s).isoformat())
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    head = subprocess.check_output(["git", "-C", str(args.benchmark), "rev-parse", "HEAD"], text=True).strip()
    if head != MANIFEST["wildclawbench_commit"]:
        raise ValueError("Benchmark checkout differs from the recorded publication snapshot")
    if subprocess.check_output(["git", "-C", str(args.benchmark), "diff", "--", "tasks", "src/utils/grading.py"]):
        raise ValueError("Task files or grading code have local modifications")
    categories = {p.name[:2]: p.name for p in (args.benchmark / "tasks").iterdir() if p.is_dir()}
    expected_tasks = {
        p.parent.name[:2] + "_task_" + p.stem.split("_task_", 1)[1].split("_", 1)[0]
        for p in (args.benchmark / "tasks").glob("*/*task_*.md")
    }
    if len(expected_tasks) != 60:
        raise ValueError("Pinned suite must contain exactly 60 task identities")
    results = []
    for model in MODELS:
        filename = "summary_all_" + model.replace("/", "_") + ".json"
        path = args.benchmark / "output/hybridclaw" / filename
        if path.exists():
            results.append(export_run(json.loads(path.read_text()), model, categories, expected_tasks, args.run_date))
    if not results:
        raise ValueError("No completed model runs; no results were written")
    args.output.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
