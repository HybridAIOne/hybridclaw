"""Rich terminal UI for skill-evolver.

Three entry points:

- ``show_result(result_path)`` — pretty-render a finished ``result.json``
  (scores, constraint gates, unified diffs, feedback trail).
- ``watch_work_dir(work_dir)`` — live-refresh the summary of a work dir
  while an evolution run writes into it.
- ``browse_skills(repo_root, datasets_dir)`` — interactive menu: pick a
  skill, preview its SKILL.md and most recent evolution run, print the
  exact CLI command to launch an evolution.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from rich.console import Console, Group
from rich.layout import Layout
from rich.live import Live
from rich.markdown import Markdown
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table
from rich.text import Text

from skill_evolver.skill_module import load_skill


def _score_row(label: str, score: Optional[dict]) -> Optional[str]:
    if not score:
        return None
    baseline = score.get("baseline", 0.0)
    best = score.get("best", 0.0)
    delta = best - baseline
    arrow = "↑" if delta > 0 else ("↓" if delta < 0 else "·")
    color = "green" if delta > 0 else ("red" if delta < 0 else "white")
    return (
        f"[bold]{label}[/bold]: {baseline:.3f} → {best:.3f} "
        f"[{color}]{arrow} {delta:+.3f}[/{color}]"
    )


def _summary_panel(result: dict) -> Panel:
    lines: list[str] = []
    lines.append(f"[bold]Skill[/bold]: {result.get('skillName', '?')}")
    lines.append(f"[bold]Run[/bold]: {result.get('runId', '?')}")
    lines.append(f"[bold]Target[/bold]: {result.get('target', '?')}")
    lines.append(
        f"[bold]Sources[/bold]: {', '.join(result.get('sources', []))}"
    )
    lines.append(f"[bold]Iterations[/bold]: {result.get('iterations', '?')}")
    if "descriptionScore" in result:
        lines.append(_score_row("Description score", result["descriptionScore"]))
    if "bodyScore" in result:
        lines.append(_score_row("Body score", result["bodyScore"]))
    applicable = result.get("applicable")
    if applicable is True:
        lines.append("[green]✅ constraints pass — variant is applicable[/green]")
    elif applicable is False:
        lines.append("[red]❌ constraints failed — variant not applied[/red]")
    return Panel("\n".join(s for s in lines if s), title="Summary", border_style="cyan")


def _constraints_table(result: dict) -> Table:
    table = Table(title="Constraint gates", show_header=True, header_style="bold")
    table.add_column("Gate")
    table.add_column("Status")
    table.add_column("Message")
    for entry in result.get("constraints", []):
        ok = entry.get("passed", False)
        table.add_row(
            entry.get("name", "?"),
            "[green]PASS[/green]" if ok else "[red]FAIL[/red]",
            entry.get("message", ""),
        )
    return table


def _dataset_table(result: dict) -> Optional[Table]:
    if "triggerDataset" not in result and "taskDataset" not in result:
        return None
    table = Table(title="Datasets", show_header=True, header_style="bold")
    table.add_column("Kind")
    table.add_column("Train")
    table.add_column("Val")
    for kind in ("triggerDataset", "taskDataset"):
        data = result.get(kind)
        if not data:
            continue
        table.add_row(
            kind.replace("Dataset", ""),
            str(data.get("train", 0)),
            str(data.get("val", 0)),
        )
    return table


def _feedback_panel(result: dict) -> Optional[Panel]:
    trail = result.get("feedbackTrail") or []
    if not trail:
        return None
    tail = trail[-6:]
    return Panel(
        "\n\n".join(str(entry) for entry in tail),
        title=f"Feedback (last {len(tail)} of {len(trail)})",
        border_style="magenta",
    )


def _report_markdown(result: dict) -> Optional[Markdown]:
    md = result.get("reportMarkdown")
    if not md:
        return None
    return Markdown(md)


def _render_result(result: dict) -> Group:
    parts = [_summary_panel(result)]
    dataset = _dataset_table(result)
    if dataset is not None:
        parts.append(dataset)
    parts.append(_constraints_table(result))
    feedback = _feedback_panel(result)
    if feedback is not None:
        parts.append(feedback)
    report = _report_markdown(result)
    if report is not None:
        parts.append(Panel(report, title="Report", border_style="green"))
    return Group(*parts)


def show_result(result_path: Path, console: Optional[Console] = None) -> None:
    console = console or Console()
    if not result_path.exists():
        console.print(f"[red]result.json not found at {result_path}[/red]")
        raise SystemExit(1)
    payload = json.loads(result_path.read_text(encoding="utf-8"))
    console.print(_render_result(payload))


def watch_work_dir(
    work_dir: Path,
    *,
    poll_interval: float = 1.5,
    max_seconds: int = 60 * 60,
    console: Optional[Console] = None,
) -> None:
    console = console or Console()
    console.print(f"[dim]Watching {work_dir} (Ctrl-C to stop)…[/dim]")
    started = time.monotonic()

    def render() -> Group:
        result_json = work_dir / "result.json"
        if not result_json.exists():
            return Group(
                Panel(
                    f"Waiting for result.json in {work_dir} …",
                    title="Evolution",
                    border_style="yellow",
                )
            )
        try:
            payload = json.loads(result_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return Group(
                Panel(
                    "result.json is being rewritten (partial read) — refreshing…",
                    border_style="yellow",
                )
            )
        return _render_result(payload)

    with Live(render(), console=console, refresh_per_second=4) as live:
        while time.monotonic() - started < max_seconds:
            live.update(render())
            result_json = work_dir / "result.json"
            if result_json.exists():
                try:
                    payload = json.loads(result_json.read_text(encoding="utf-8"))
                    if payload.get("finishedAt") or payload.get("error"):
                        break
                except json.JSONDecodeError:
                    pass
            time.sleep(poll_interval)


@dataclass
class SkillRow:
    name: str
    path: Path
    description: str
    body_bytes: int


def _walk_skills(repo_root: Path, max_count: int = 200) -> list[SkillRow]:
    rows: list[SkillRow] = []
    for rel in ("skills", "community-skills", "plugins"):
        root = repo_root / rel
        if not root.exists():
            continue
        for skill_md in root.rglob("SKILL.md"):
            try:
                parsed = load_skill(skill_md)
            except Exception:
                continue
            rows.append(
                SkillRow(
                    name=parsed.name,
                    path=skill_md,
                    description=parsed.description,
                    body_bytes=len(parsed.body.encode("utf-8")),
                )
            )
            if len(rows) >= max_count:
                return rows
    return rows


def _skills_table(rows: list[SkillRow]) -> Table:
    table = Table(title="Skills", show_header=True, header_style="bold")
    table.add_column("#", justify="right")
    table.add_column("Name")
    table.add_column("Body bytes", justify="right")
    table.add_column("Description", overflow="fold")
    for index, row in enumerate(rows, start=1):
        description = row.description.strip().splitlines()[0] if row.description else ""
        if len(description) > 120:
            description = description[:117] + "…"
        table.add_row(
            str(index),
            row.name,
            str(row.body_bytes),
            description,
        )
    return table


def browse_skills(
    repo_root: Path,
    datasets_dir: Path,
    console: Optional[Console] = None,
) -> None:
    console = console or Console()
    rows = _walk_skills(repo_root)
    if not rows:
        console.print(f"[yellow]No SKILL.md found under {repo_root}[/yellow]")
        return

    while True:
        console.clear()
        console.print(_skills_table(rows))
        console.print(
            "[dim]Enter a skill number to inspect, or 'q' to quit.[/dim]"
        )
        choice = Prompt.ask("Skill", default="q").strip()
        if choice.lower() in {"q", "quit", "exit"}:
            return
        try:
            index = int(choice)
        except ValueError:
            console.print("[red]Not a number.[/red]")
            time.sleep(0.6)
            continue
        if not 1 <= index <= len(rows):
            console.print("[red]Out of range.[/red]")
            time.sleep(0.6)
            continue
        _inspect_skill(rows[index - 1], repo_root, datasets_dir, console)


def _inspect_skill(
    row: SkillRow,
    repo_root: Path,
    datasets_dir: Path,
    console: Console,
) -> None:
    console.clear()
    layout = Layout()
    layout.split_column(
        Layout(name="head", size=6),
        Layout(name="body"),
    )
    layout["head"].update(
        Panel(
            Text.assemble(
                ("name: ", "bold"),
                f"{row.name}\n",
                ("path: ", "bold"),
                f"{row.path.relative_to(repo_root) if row.path.is_relative_to(repo_root) else row.path}\n",
                ("body_bytes: ", "bold"),
                f"{row.body_bytes}\n",
                ("description:\n", "bold"),
                row.description or "",
            ),
            title=row.name,
            border_style="cyan",
        )
    )

    skill_md = Markdown(row.path.read_text(encoding="utf-8"))
    layout["body"].update(Panel(skill_md, title="SKILL.md", border_style="dim"))
    console.print(layout)

    console.print(
        "\n[dim]Commands to launch evolution (run outside the TUI):[/dim]"
    )
    console.print(
        f"  [green]hybridclaw skill-evolver evolve {row.name} --target description[/green]"
    )
    console.print(
        f"  [green]hybridclaw skill-evolver evolve {row.name} --target body[/green]"
    )
    console.print(
        f"  [green]hybridclaw skill-evolver evolve {row.name} --target both --open-pr[/green]"
    )
    console.print(
        f"\n[dim]Datasets for this skill live under {datasets_dir / row.name}[/dim]"
    )
    Prompt.ask("\nPress Enter to return", default="")
