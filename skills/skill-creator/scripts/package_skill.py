#!/usr/bin/env python3
"""
Create a secure .skill archive from a skill directory.

Security goals:
- reject symlinks in input tree
- reject files that resolve outside the skill root
- reject archive entries with absolute paths or traversal segments
"""

from __future__ import annotations

import argparse
import stat
import sys
import zipfile
from pathlib import Path
from typing import List, Optional, Sequence, Tuple


class PackagingError(Exception):
    """Base error for packaging failures."""


class SecurityError(PackagingError):
    """Raised when a security check fails."""


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _validate_relative_path(rel_path: Path) -> None:
    if rel_path.is_absolute():
        raise SecurityError(f"Absolute paths are not allowed: {rel_path}")

    for part in rel_path.parts:
        if part in {"", ".", ".."}:
            raise SecurityError(f"Unsafe path segment '{part}' in {rel_path}")


def collect_skill_files(skill_dir: Path) -> List[Tuple[Path, Path]]:
    root = skill_dir.resolve()
    if not root.exists() or not root.is_dir():
        raise PackagingError(f"Skill directory not found: {root}")

    files: List[Tuple[Path, Path]] = []
    for candidate in sorted(root.rglob("*")):
        if candidate.is_symlink():
            raise SecurityError(f"Symlink is not allowed in skill package input: {candidate}")

        if candidate.is_dir():
            continue

        resolved = candidate.resolve()
        if not _is_within(resolved, root):
            raise SecurityError(f"File resolves outside skill root: {candidate}")

        rel_path = resolved.relative_to(root)
        _validate_relative_path(rel_path)
        files.append((resolved, rel_path))

    if not any(rel.as_posix() == "SKILL.md" for _, rel in files):
        raise PackagingError("SKILL.md is required and was not found")

    return files


def verify_archive(archive_path: Path, skill_name: str) -> None:
    prefix = f"{skill_name}/"

    with zipfile.ZipFile(archive_path, "r") as zf:
        names = zf.namelist()
        if not names:
            raise PackagingError("Created archive is empty")

        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if name.startswith("/"):
                raise SecurityError(f"Archive contains absolute path entry: {name}")
            if not name.startswith(prefix):
                raise SecurityError(
                    f"Archive entry '{name}' does not start with expected root '{prefix}'"
                )

            rel = Path(name[len(prefix) :])
            if rel.as_posix() in {"", "."}:
                continue
            _validate_relative_path(rel)

            mode = (info.external_attr >> 16) & 0o170000
            if mode == stat.S_IFLNK:
                raise SecurityError(f"Archive contains symlink entry: {name}")


def package_skill(
    skill_dir: Path,
    output_dir: Optional[Path] = None,
    overwrite: bool = False,
) -> Path:
    skill_dir = skill_dir.resolve()
    skill_name = skill_dir.name

    files = collect_skill_files(skill_dir)

    target_dir = (output_dir or skill_dir.parent).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    archive_path = target_dir / f"{skill_name}.skill"

    if archive_path.exists() and not overwrite:
        raise PackagingError(
            f"Archive already exists: {archive_path}. Use --overwrite to replace it."
        )

    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for abs_path, rel_path in files:
            arcname = f"{skill_name}/{rel_path.as_posix()}"
            zf.write(abs_path, arcname)

    verify_archive(archive_path, skill_name)
    return archive_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Package a skill directory into a .skill archive")
    parser.add_argument("skill_dir", help="Path to skill directory")
    parser.add_argument(
        "--output-dir",
        help="Output directory for the archive (defaults to skill parent directory)",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing archive if present",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    skill_dir = Path(args.skill_dir)
    output_dir = Path(args.output_dir).resolve() if args.output_dir else None

    try:
        archive = package_skill(skill_dir=skill_dir, output_dir=output_dir, overwrite=args.overwrite)
    except PackagingError as exc:
        print(f"[FAIL] {exc}")
        return 1

    print(f"[PASS] Created package: {archive}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
