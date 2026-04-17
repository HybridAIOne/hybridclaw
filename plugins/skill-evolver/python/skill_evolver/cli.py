"""CLI entry point — `python -m skill_evolver <subcommand> …`."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import click
from rich.console import Console

from skill_evolver.evolve import EvolveConfig, run as run_evolution

console = Console()


@click.group()
def main() -> None:
    """HybridClaw skill evolver."""


@main.command("evolve")
@click.option("--skill-path", type=click.Path(exists=True, dir_okay=False, path_type=Path), required=True)
@click.option("--skill-name", required=True)
@click.option("--target", type=click.Choice(["description", "body", "both"]), required=True)
@click.option("--iterations", type=int, default=10, show_default=True)
@click.option("--sources", default="synthetic,golden,traces", show_default=True)
@click.option("--optimizer-model", default="openai/gpt-4.1", show_default=True)
@click.option("--eval-model", default="openai/gpt-4.1-mini", show_default=True)
@click.option("--max-body-bytes", type=int, default=15360, show_default=True)
@click.option("--max-description-chars", type=int, default=1024, show_default=True)
@click.option("--repo-root", type=click.Path(exists=True, file_okay=False, path_type=Path), required=True)
@click.option("--datasets-dir", type=click.Path(path_type=Path), required=True)
@click.option("--work-dir", type=click.Path(path_type=Path), required=True)
@click.option("--traces-dataset", type=click.Path(path_type=Path), default=None)
@click.option("--dry-run", is_flag=True)
def evolve_cmd(
    skill_path: Path,
    skill_name: str,
    target: str,
    iterations: int,
    sources: str,
    optimizer_model: str,
    eval_model: str,
    max_body_bytes: int,
    max_description_chars: int,
    repo_root: Path,
    datasets_dir: Path,
    work_dir: Path,
    traces_dataset: Path | None,
    dry_run: bool,
) -> None:
    source_list = [s.strip() for s in sources.split(",") if s.strip()]
    config = EvolveConfig(
        skill_path=skill_path,
        skill_name=skill_name,
        target=target,
        sources=source_list,
        iterations=iterations,
        optimizer_model=optimizer_model,
        eval_model=eval_model,
        max_body_bytes=max_body_bytes,
        max_description_chars=max_description_chars,
        repo_root=repo_root,
        datasets_dir=datasets_dir,
        work_dir=work_dir,
        traces_dataset_path=traces_dataset,
        dry_run=dry_run,
    )
    try:
        result = run_evolution(config)
    except Exception as err:  # pragma: no cover
        console.print(f"[red]Evolution failed: {err}[/red]")
        sys.exit(1)
    console.print_json(json.dumps({"runId": result.get("runId"), "applicable": result.get("applicable", False)}))


@main.command("version")
def version_cmd() -> None:
    from skill_evolver import __version__
    console.print(__version__)


@main.command("show")
@click.argument(
    "result_path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
def show_cmd(result_path: Path) -> None:
    """Pretty-render a completed run's result.json."""
    from skill_evolver.tui import show_result

    show_result(result_path, console=console)


@main.command("watch")
@click.argument(
    "work_dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
)
@click.option("--poll-interval", type=float, default=1.5, show_default=True)
def watch_cmd(work_dir: Path, poll_interval: float) -> None:
    """Live-refresh the summary of a work dir while evolution runs."""
    from skill_evolver.tui import watch_work_dir

    watch_work_dir(work_dir, poll_interval=poll_interval, console=console)


@main.command("tui")
@click.option(
    "--repo-root",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--datasets-dir",
    type=click.Path(path_type=Path),
    required=True,
)
def tui_cmd(repo_root: Path, datasets_dir: Path) -> None:
    """Browse skills in an interactive terminal UI."""
    from skill_evolver.tui import browse_skills

    browse_skills(repo_root, datasets_dir, console=console)


if __name__ == "__main__":
    main()
