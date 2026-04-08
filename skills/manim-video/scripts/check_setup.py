#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass


@dataclass
class CheckResult:
    name: str
    ok: bool
    required: bool
    detail: str


def run_command(argv: list[str]) -> tuple[bool, str]:
    try:
        completed = subprocess.run(
            argv,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        return False, str(exc)

    output = (completed.stdout or completed.stderr or '').strip()
    return completed.returncode == 0, output


def check_python() -> CheckResult:
    version = '.'.join(str(part) for part in sys.version_info[:3])
    ok = sys.version_info >= (3, 10)
    detail = f'Python {version}'
    if not ok:
        detail += ' (requires Python 3.10+)'
    return CheckResult('python', ok, True, detail)


def check_manim() -> CheckResult:
    if importlib.util.find_spec('manim') is None:
        return CheckResult(
            'manim',
            False,
            True,
            'Python package not found. Install with `uv tool install manim` or `pip install manim`.',
        )

    ok, output = run_command([sys.executable, '-m', 'manim', '--version'])
    detail = output.splitlines()[0] if output else 'Manim package importable'
    if not ok:
        detail = f'Manim import exists, but `python3 -m manim --version` failed: {detail}'
    return CheckResult('manim', ok, True, detail)


def check_binary(name: str, *, required: bool, missing_detail: str) -> CheckResult:
    resolved = shutil.which(name)
    if not resolved:
        return CheckResult(name, False, required, missing_detail)

    version_args = [name, '--version']
    if name == 'ffmpeg':
        version_args = [name, '-version']

    ok, output = run_command(version_args)
    detail = output.splitlines()[0] if output else resolved
    return CheckResult(name, ok, required, detail)


def summarize(checks: list[CheckResult]) -> dict[str, object]:
    required_failures = [check for check in checks if check.required and not check.ok]
    optional_failures = [check for check in checks if not check.required and not check.ok]

    if required_failures:
        status = 'error'
        summary = 'Missing required dependencies for rendering.'
    elif optional_failures:
        status = 'warning'
        summary = 'Core rendering is available, but some optional features are unavailable.'
    else:
        status = 'ok'
        summary = 'Ready to plan, render, and stitch Manim videos.'

    return {
        'status': status,
        'summary': summary,
        'checks': [asdict(check) for check in checks],
    }


def print_text(summary: dict[str, object]) -> None:
    print('Manim Video setup check')
    print()
    for raw_check in summary['checks']:
        check = CheckResult(**raw_check)
        label = 'ok' if check.ok else 'warn' if not check.required else 'error'
        print(f'[{label}] {check.name}: {check.detail}')
    print()
    print(summary['summary'])


def main() -> int:
    parser = argparse.ArgumentParser(description='Check Manim video prerequisites')
    parser.add_argument(
        '--format',
        choices=('text', 'json'),
        default='text',
        help='Output format',
    )
    args = parser.parse_args()

    checks = [
        check_python(),
        check_manim(),
        check_binary(
            'ffmpeg',
            required=True,
            missing_detail='ffmpeg not found. Install it before stitching video output.',
        ),
        check_binary(
            'pdflatex',
            required=False,
            missing_detail='pdflatex not found. MathTex and Tex scenes will not render until LaTeX is installed.',
        ),
    ]
    summary = summarize(checks)

    if args.format == 'json':
        print(json.dumps(summary, indent=2))
    else:
        print_text(summary)

    return 0 if summary['status'] != 'error' else 1


if __name__ == '__main__':
    raise SystemExit(main())
