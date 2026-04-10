#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
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


def run_command(argv: list[str], *, cwd: str | None = None) -> tuple[bool, str]:
    try:
        completed = subprocess.run(
            argv,
            check=False,
            capture_output=True,
            cwd=cwd,
            text=True,
        )
    except OSError as exc:
        return False, str(exc)

    output = (completed.stdout or completed.stderr or '').strip()
    return completed.returncode == 0, output


def first_line(output: str, fallback: str) -> str:
    if not output:
        return fallback
    return output.splitlines()[0]


def resolve_binary(name: str) -> str | None:
    resolved = shutil.which(name)
    if resolved:
        return resolved

    if sys.platform == 'darwin':
        mactex_candidate = f'/Library/TeX/texbin/{name}'
        if os.path.exists(mactex_candidate):
            return mactex_candidate

    return None


def check_python() -> CheckResult:
    version = '.'.join(str(part) for part in sys.version_info[:3])
    ok = sys.version_info >= (3, 10)
    detail = f'Python {version}'
    if not ok:
        detail += ' (requires Python 3.10+)'
    return CheckResult('python', ok, True, detail)


def check_host_python_manim() -> CheckResult | None:
    if importlib.util.find_spec('manim') is None:
        return None

    ok, output = run_command([sys.executable, '-m', 'manim', '--version'])
    detail = first_line(output, 'Host Manim package importable')
    if not ok:
        detail = f'Manim import exists, but `python3 -m manim --version` failed: {detail}'
    return CheckResult('manim', ok, True, f'{detail} (host Python)')


def check_host_cli_manim() -> CheckResult | None:
    resolved = resolve_binary('manim')
    if not resolved:
        return None

    ok, output = run_command([resolved, '--version'])
    detail = first_line(output, resolved)
    if not ok:
        detail = f'`manim --version` failed: {detail}'
    return CheckResult('manim', ok, True, f'{detail} (host CLI)')


def check_manim() -> CheckResult:
    host_python_result = check_host_python_manim()
    if host_python_result and host_python_result.ok:
        return host_python_result

    host_cli_result = check_host_cli_manim()
    if host_cli_result and host_cli_result.ok:
        return host_cli_result

    if host_python_result:
        return host_python_result
    if host_cli_result:
        return host_cli_result

    return CheckResult(
        'manim',
        False,
        True,
        'Render dependency missing. Install with `uv tool install manim` or `python3 -m pip install manim`.',
    )


def check_binary(name: str, *, required: bool, missing_detail: str) -> CheckResult:
    resolved = resolve_binary(name)
    if not resolved:
        return CheckResult(name, False, required, missing_detail)

    version_args = [resolved, '--version']
    if name == 'ffmpeg':
        version_args = [resolved, '-version']

    ok, output = run_command(version_args)
    detail = output.splitlines()[0] if output else resolved
    return CheckResult(name, ok, required, detail)


def summarize(checks: list[CheckResult]) -> dict[str, object]:
    failed_checks = [check for check in checks if not check.ok]
    render_blockers = [check for check in checks if check.required and not check.ok]
    optional_failures = [check for check in checks if not check.required and not check.ok]

    if render_blockers:
        status = 'warning'
        summary = (
            'Planning and script editing can continue, but rendering is '
            'blocked until the missing dependencies are installed.'
        )
    elif optional_failures:
        status = 'warning'
        summary = (
            'Core rendering is available, but some optional features are unavailable.'
        )
    else:
        status = 'ok'
        summary = 'Ready to plan, render, and stitch Manim videos.'

    return {
        'status': status,
        'summary': summary,
        'render_ready': len(render_blockers) == 0,
        'failed_check_count': len(failed_checks),
        'checks': [asdict(check) for check in checks],
    }


def print_text(summary: dict[str, object]) -> None:
    print('Manim Video setup check')
    print()
    for raw_check in summary['checks']:
        check = CheckResult(**raw_check)
        label = 'ok' if check.ok else 'warn'
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
    parser.add_argument(
        '--strict',
        action='store_true',
        help='Exit nonzero when any render-blocking dependency is missing',
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
            missing_detail=(
                'pdflatex not found. MathTex and Tex scenes will not render until '
                'LaTeX is installed. macOS: `brew install --cask mactex-no-gui`; '
                'Debian/Ubuntu: `sudo apt install texlive-full`; Fedora: '
                '`sudo dnf install texlive-scheme-full`.'
            ),
        ),
    ]
    summary = summarize(checks)

    if args.format == 'json':
        print(json.dumps(summary, indent=2))
    else:
        print_text(summary)

    return 1 if args.strict and not summary['render_ready'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
