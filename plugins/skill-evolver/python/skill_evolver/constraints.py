"""Hard constraints that every evolved variant must satisfy.

These are gates, not scores. If any gate fails, the variant is rejected
regardless of how good its fitness score looks. Soft quality signals belong
in fitness/ instead.
"""
from __future__ import annotations

import re
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class ConstraintResult:
    name: str
    passed: bool
    message: str
    detail: str = ""


def check_size_body(body: str, *, max_bytes: int) -> ConstraintResult:
    size = len(body.encode("utf-8"))
    passed = size <= max_bytes
    return ConstraintResult(
        name="body_size",
        passed=passed,
        message=f"body is {size} bytes (limit {max_bytes})",
    )


def check_size_description(description: str, *, max_chars: int) -> ConstraintResult:
    size = len(description)
    passed = 0 < size <= max_chars
    return ConstraintResult(
        name="description_size",
        passed=passed,
        message=f"description is {size} chars (limit {max_chars})",
    )


def check_description_shape(description: str) -> ConstraintResult:
    stripped = description.strip()
    if not stripped:
        return ConstraintResult("description_shape", False, "description is empty")
    if "\n\n" in stripped:
        return ConstraintResult(
            "description_shape", False, "description should be a single paragraph"
        )
    if len(stripped) < 20:
        return ConstraintResult(
            "description_shape", False, "description is too short to be useful"
        )
    return ConstraintResult("description_shape", True, "description shape ok")


def check_body_structure(body: str) -> ConstraintResult:
    stripped = body.strip()
    if not stripped:
        return ConstraintResult("body_structure", False, "body is empty")
    if not re.search(r"^#\s+", stripped, re.MULTILINE):
        return ConstraintResult(
            "body_structure",
            False,
            "body has no top-level heading — skills should open with a title",
        )
    return ConstraintResult("body_structure", True, "body structure ok")


def check_no_frontmatter_leak(body: str) -> ConstraintResult:
    if body.lstrip().startswith("---"):
        return ConstraintResult(
            "no_frontmatter_leak",
            False,
            "body begins with frontmatter markers — mutator leaked YAML",
        )
    return ConstraintResult("no_frontmatter_leak", True, "no frontmatter in body")


def check_growth_cap(
    body: str, *, baseline_body: str, growth_multiplier: float = 1.5
) -> ConstraintResult:
    baseline_size = len(baseline_body.encode("utf-8"))
    size = len(body.encode("utf-8"))
    limit = int(baseline_size * growth_multiplier)
    passed = size <= limit
    return ConstraintResult(
        name="body_growth",
        passed=passed,
        message=f"body {size}B vs baseline {baseline_size}B × {growth_multiplier} = {limit}B",
    )


def run_test_suite(
    command: str, cwd: Path, *, timeout_s: int = 600
) -> ConstraintResult:
    try:
        parts = shlex.split(command or "")
    except ValueError as err:
        return ConstraintResult(
            "test_suite", False, f"could not parse test command: {err}"
        )
    if not parts:
        return ConstraintResult("test_suite", True, "test command empty — skipped")
    try:
        result = subprocess.run(
            parts,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return ConstraintResult(
            "test_suite", False, f"test suite timed out after {timeout_s}s"
        )
    except FileNotFoundError as err:
        return ConstraintResult(
            "test_suite", False, f"test command not found: {err}"
        )
    tail = (result.stdout or result.stderr or "").strip().splitlines()[-5:]
    return ConstraintResult(
        name="test_suite",
        passed=result.returncode == 0,
        message=f"exit={result.returncode}",
        detail="\n".join(tail),
    )


def validate_description(
    description: str, *, max_chars: int
) -> list[ConstraintResult]:
    return [
        check_size_description(description, max_chars=max_chars),
        check_description_shape(description),
    ]


def validate_body(
    body: str,
    *,
    baseline_body: str,
    max_bytes: int,
) -> list[ConstraintResult]:
    return [
        check_size_body(body, max_bytes=max_bytes),
        check_body_structure(body),
        check_no_frontmatter_leak(body),
        check_growth_cap(body, baseline_body=baseline_body),
    ]


def all_passed(results: list[ConstraintResult]) -> bool:
    return all(r.passed for r in results)


def summarize(results: list[ConstraintResult]) -> str:
    return "\n".join(
        f"  [{'PASS' if r.passed else 'FAIL'}] {r.name}: {r.message}"
        for r in results
    )
