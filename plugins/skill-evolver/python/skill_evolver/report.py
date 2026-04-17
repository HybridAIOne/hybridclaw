"""Render a human-readable markdown report for an evolution run.

Used both as PR-body content and as the console UI's diff summary.
"""
from __future__ import annotations

import difflib

from skill_evolver.skill_module import ParsedSkill


def _diff(before: str, after: str, label_before: str, label_after: str) -> str:
    if before == after:
        return f"(no change to {label_before})"
    diff_lines = difflib.unified_diff(
        before.splitlines(keepends=False),
        after.splitlines(keepends=False),
        fromfile=label_before,
        tofile=label_after,
        lineterm="",
        n=3,
    )
    body = "\n".join(diff_lines)
    if not body.strip():
        return f"(no visible diff for {label_before})"
    return f"```diff\n{body}\n```"


def render_report_markdown(skill: ParsedSkill, result: dict) -> str:
    lines: list[str] = []
    lines.append(f"# Evolution report: `{skill.name}`")
    lines.append("")
    lines.append(
        f"**Run**: `{result.get('runId', '?')}` · "
        f"**Target**: `{result.get('target')}` · "
        f"**Sources**: `{', '.join(result.get('sources', []))}` · "
        f"**Iterations**: `{result.get('iterations')}`"
    )
    lines.append("")

    desc_score = result.get("descriptionScore")
    body_score = result.get("bodyScore")
    if desc_score:
        delta = desc_score["best"] - desc_score["baseline"]
        lines.append(
            f"- Description score: **{desc_score['baseline']:.3f} → {desc_score['best']:.3f}** "
            f"({'+' if delta >= 0 else ''}{delta:.3f})"
        )
    if body_score:
        delta = body_score["best"] - body_score["baseline"]
        lines.append(
            f"- Body score: **{body_score['baseline']:.3f} → {body_score['best']:.3f}** "
            f"({'+' if delta >= 0 else ''}{delta:.3f})"
        )
    lines.append("")

    lines.append("## Constraint gates")
    for constraint in result.get("constraints", []):
        badge = "✅" if constraint["passed"] else "❌"
        lines.append(f"- {badge} `{constraint['name']}` — {constraint['message']}")
    lines.append("")

    lines.append("## Changes")
    best_raw = result.get("bestVariantRaw")
    if best_raw:
        from skill_evolver.skill_module import load_skill
        from io import StringIO  # noqa: F401 - kept for parity with SKILL parser imports

        new_description = best_raw.split("\n---\n", 1)[0]
        if "description:" in new_description:
            new_desc_line = (
                new_description.split("description:", 1)[1].split("\n", 1)[0].strip()
            )
        else:
            new_desc_line = skill.description
        lines.append("### Description")
        lines.append(_diff(skill.description, new_desc_line, "before", "after"))
        lines.append("")

        new_body = best_raw.split("\n---\n", 1)[1] if "\n---\n" in best_raw else ""
        if new_body:
            lines.append("### Body")
            lines.append(_diff(skill.body, new_body.lstrip("\n"), "before", "after"))
            lines.append("")

    lines.append("## Sample feedback")
    for entry in result.get("feedbackTrail", [])[-4:]:
        lines.append(f"> {entry}")
        lines.append("")
    return "\n".join(lines)
