#!/usr/bin/env python3
"""
Initialize a new skill folder with SKILL.md and optional resources.

Usage:
    python3 scripts/init_skill.py <skill-name> --path <skills-root>
    python3 scripts/init_skill.py <skill-name> --path <skills-root> --resources scripts,references
    python3 scripts/init_skill.py <skill-name> --path <skills-root> --resources scripts --examples
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import List, Optional, Sequence

from generate_openai_yaml import write_openai_yaml

MAX_SKILL_NAME_LENGTH = 64
ALLOWED_RESOURCES = {"scripts", "references", "assets"}

SKILL_TEMPLATE = """---
name: {skill_name}
description: "[TODO: Describe what this skill does and when to use it. Include concrete trigger phrases.]"
category: "[TODO: Top category like development, office, apple, or memory.]"
---

# {skill_title}

## Overview

[TODO: 1-2 sentences describing what this skill enables.]

## Workflow

1. [TODO: Define the primary entry workflow.]
2. [TODO: Link to scripts/references where needed.]
3. [TODO: Define success criteria and output contract.]

## Command Contract

- [TODO: List the exact command patterns or invocation forms this skill supports.]

## References

- [TODO: Link to `references/*.md` files when deep detail is needed.]

## Validation

Run:

```bash
python3 scripts/quick_validate.py <path/to/skill>
```
"""

EXAMPLE_SCRIPT = """#!/usr/bin/env python3
\"\"\"Example helper script for {skill_name}.\"\"\"


def main() -> None:
    print("Replace this script with skill-specific logic.")


if __name__ == "__main__":
    main()
"""

EXAMPLE_REFERENCE = """# Reference Guide

Replace this file with domain-specific guidance used by the skill.
"""

EXAMPLE_ASSET = """Replace this file with real output assets if needed."""


def normalize_skill_name(raw_name: str) -> str:
    name = raw_name.strip().lower()
    name = re.sub(r"[^a-z0-9]+", "-", name)
    name = re.sub(r"-{2,}", "-", name).strip("-")
    return name


def title_case(skill_name: str) -> str:
    return " ".join(chunk.capitalize() for chunk in skill_name.split("-") if chunk)


def parse_resources(raw_resources: str) -> List[str]:
    if not raw_resources:
        return []

    items = [item.strip() for item in raw_resources.split(",") if item.strip()]
    deduped: List[str] = []
    seen = set()
    for item in items:
        if item not in ALLOWED_RESOURCES:
            allowed = ", ".join(sorted(ALLOWED_RESOURCES))
            raise ValueError(f"Unknown resource '{item}'. Allowed: {allowed}")
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)
    return deduped


def create_resource_dirs(
    skill_dir: Path,
    skill_name: str,
    resources: Sequence[str],
    include_examples: bool,
) -> None:
    for resource in resources:
        resource_dir = skill_dir / resource
        resource_dir.mkdir(parents=True, exist_ok=True)
        print(f"[OK] Created {resource_dir}")

        if not include_examples:
            continue

        if resource == "scripts":
            script_path = resource_dir / "example.py"
            script_path.write_text(EXAMPLE_SCRIPT.format(skill_name=skill_name), encoding="utf-8")
            script_path.chmod(0o755)
            print(f"[OK] Added {script_path}")
        elif resource == "references":
            ref_path = resource_dir / "overview.md"
            ref_path.write_text(EXAMPLE_REFERENCE, encoding="utf-8")
            print(f"[OK] Added {ref_path}")
        elif resource == "assets":
            asset_path = resource_dir / "placeholder.txt"
            asset_path.write_text(EXAMPLE_ASSET, encoding="utf-8")
            print(f"[OK] Added {asset_path}")


def init_skill(
    skill_name: str,
    output_root: Path,
    resources: Sequence[str],
    include_examples: bool,
    interface_overrides: Sequence[str],
) -> Optional[Path]:
    skill_dir = output_root / skill_name

    if skill_dir.exists():
        print(f"[ERROR] Skill directory already exists: {skill_dir}")
        return None

    try:
        skill_dir.mkdir(parents=True, exist_ok=False)
        print(f"[OK] Created skill directory: {skill_dir}")
    except OSError as exc:
        print(f"[ERROR] Failed to create directory: {exc}")
        return None

    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text(
        SKILL_TEMPLATE.format(skill_name=skill_name, skill_title=title_case(skill_name)),
        encoding="utf-8",
    )
    print(f"[OK] Wrote {skill_md}")

    if write_openai_yaml(skill_dir, skill_name, interface_overrides) is None:
        return None

    create_resource_dirs(skill_dir, skill_name, resources, include_examples)

    print("\nNext steps:")
    print("1. Replace TODO placeholders in SKILL.md")
    print("2. Add only the resources the skill actually needs")
    print("3. Run: python3 scripts/quick_validate.py <path/to/skill>")
    return skill_dir


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Initialize a new skill folder")
    parser.add_argument("skill_name", help="Skill name (normalized to hyphen-case)")
    parser.add_argument("--path", required=True, help="Output directory where the skill folder will be created")
    parser.add_argument(
        "--resources",
        default="",
        help="Comma-separated resource directories to create: scripts,references,assets",
    )
    parser.add_argument(
        "--examples",
        action="store_true",
        help="Create example files in requested resource directories",
    )
    parser.add_argument(
        "--interface",
        action="append",
        default=[],
        help="Override openai.yaml interface values with key=value (repeatable)",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    normalized = normalize_skill_name(args.skill_name)
    if not normalized:
        print("[ERROR] Skill name must include at least one letter or digit")
        return 1

    if len(normalized) > MAX_SKILL_NAME_LENGTH:
        print(
            f"[ERROR] Skill name '{normalized}' is too long ({len(normalized)} > {MAX_SKILL_NAME_LENGTH})"
        )
        return 1

    if normalized != args.skill_name:
        print(f"[INFO] Normalized skill name '{args.skill_name}' -> '{normalized}'")

    try:
        resources = parse_resources(args.resources)
    except ValueError as exc:
        print(f"[ERROR] {exc}")
        return 1

    if args.examples and not resources:
        print("[ERROR] --examples requires --resources")
        return 1

    output_root = Path(args.path).resolve()
    result = init_skill(
        skill_name=normalized,
        output_root=output_root,
        resources=resources,
        include_examples=args.examples,
        interface_overrides=args.interface,
    )
    return 0 if result else 1


if __name__ == "__main__":
    sys.exit(main())
