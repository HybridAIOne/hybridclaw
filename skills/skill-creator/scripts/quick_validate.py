#!/usr/bin/env python3
"""
Quick validation for skill folders.

Checks:
- SKILL.md exists and frontmatter parses
- required frontmatter fields are present and valid
- optional agents/openai.yaml structure is valid
- basic naming and description constraints

Includes a no-PyYAML fallback parser for simple YAML structures.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

MAX_SKILL_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024
ALLOWED_FRONTMATTER_KEYS = {
    "name",
    "description",
    "category",
    "user-invocable",
    "disable-model-invocation",
    "always",
    "requires",
    "metadata",
    "license",
    "allowed-tools",
}


def parse_scalar(raw: str) -> Any:
    value = raw.strip()
    if not value:
        return ""

    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]

    lowered = value.lower()
    if lowered in {"true", "yes", "on"}:
        return True
    if lowered in {"false", "no", "off"}:
        return False
    if lowered in {"null", "none", "~"}:
        return None

    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [parse_scalar(chunk) for chunk in inner.split(",")]

    if re.match(r"^-?\d+$", value):
        try:
            return int(value)
        except ValueError:
            return value

    return value


def fallback_yaml_parse(text: str) -> Dict[str, Any]:
    root: Dict[str, Any] = {}
    stack: List[Tuple[int, Dict[str, Any]]] = [(-1, root)]

    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.strip().startswith("#"):
            continue

        indent = len(raw_line) - len(raw_line.lstrip(" "))
        line = raw_line.strip()

        if line.startswith("- "):
            # Minimal fallback parser: ignore complex list blocks.
            continue

        if ":" not in line:
            continue

        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()

        key, raw_value = line.split(":", 1)
        key = key.strip()
        raw_value = raw_value.strip()

        target = stack[-1][1]
        if not raw_value:
            child: Dict[str, Any] = {}
            target[key] = child
            stack.append((indent, child))
            continue

        target[key] = parse_scalar(raw_value)

    return root


def parse_yaml(text: str) -> Dict[str, Any]:
    try:
        import yaml  # type: ignore

        parsed = yaml.safe_load(text)
        if isinstance(parsed, dict):
            return parsed
        return {}
    except Exception:
        return fallback_yaml_parse(text)


def extract_frontmatter(skill_md_text: str) -> Optional[str]:
    match = re.match(r"^---\n([\s\S]*?)\n---", skill_md_text)
    if not match:
        return None
    return match.group(1)


def validate_frontmatter(frontmatter: Dict[str, Any]) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []

    unknown_keys = sorted(set(frontmatter.keys()) - ALLOWED_FRONTMATTER_KEYS)
    if unknown_keys:
        errors.append(
            "Unexpected frontmatter keys: "
            + ", ".join(unknown_keys)
            + ". Allowed: "
            + ", ".join(sorted(ALLOWED_FRONTMATTER_KEYS))
        )

    name = frontmatter.get("name")
    if not isinstance(name, str) or not name.strip():
        errors.append("Missing or invalid frontmatter field: name")
    else:
        normalized = name.strip()
        if not re.match(r"^[a-z0-9-]+$", normalized):
            errors.append(
                f"Skill name '{normalized}' must be lowercase hyphen-case (a-z, 0-9, -)"
            )
        if normalized.startswith("-") or normalized.endswith("-") or "--" in normalized:
            errors.append(f"Skill name '{normalized}' cannot start/end with '-' or include '--'")
        if len(normalized) > MAX_SKILL_NAME_LENGTH:
            errors.append(
                f"Skill name '{normalized}' is too long ({len(normalized)} > {MAX_SKILL_NAME_LENGTH})"
            )

    description = frontmatter.get("description")
    if not isinstance(description, str) or not description.strip():
        errors.append("Missing or invalid frontmatter field: description")
    else:
        trimmed = description.strip()
        if len(trimmed) > MAX_DESCRIPTION_LENGTH:
            errors.append(
                f"Description too long ({len(trimmed)} > {MAX_DESCRIPTION_LENGTH} characters)"
            )
        if "[TODO" in trimmed:
            warnings.append("Description still contains TODO marker")

    category = frontmatter.get("category")
    if not isinstance(category, str) or not category.strip():
        errors.append("Missing or invalid frontmatter field: category")
    else:
        normalized_category = category.strip()
        if not re.match(r"^[a-z0-9-]+$", normalized_category):
            errors.append(
                f"Skill category '{normalized_category}' must be lowercase hyphen-case (a-z, 0-9, -)"
            )

    return errors, warnings


def validate_openai_yaml(skill_path: Path, skill_name: str) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []

    openai_yaml = skill_path / "agents" / "openai.yaml"
    if not openai_yaml.exists():
        return errors, warnings

    parsed = parse_yaml(openai_yaml.read_text(encoding="utf-8"))
    interface = parsed.get("interface") if isinstance(parsed, dict) else None

    if not isinstance(interface, dict):
        errors.append("agents/openai.yaml must include top-level 'interface' map")
        return errors, warnings

    display_name = interface.get("display_name")
    short_description = interface.get("short_description")

    if not isinstance(display_name, str) or not display_name.strip():
        errors.append("agents/openai.yaml interface.display_name is required")

    if not isinstance(short_description, str) or not short_description.strip():
        errors.append("agents/openai.yaml interface.short_description is required")
    elif not (25 <= len(short_description) <= 64):
        errors.append(
            "agents/openai.yaml interface.short_description must be 25-64 characters"
        )

    brand_color = interface.get("brand_color")
    if isinstance(brand_color, str) and brand_color and not re.match(r"^#[0-9A-Fa-f]{6}$", brand_color):
        errors.append("agents/openai.yaml interface.brand_color must be #RRGGBB")

    default_prompt = interface.get("default_prompt")
    if isinstance(default_prompt, str) and default_prompt.strip():
        if f"${skill_name}" not in default_prompt:
            warnings.append(
                f"interface.default_prompt should mention ${skill_name} for explicit invocation clarity"
            )

    return errors, warnings


def validate_files(skill_path: Path) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        errors.append("SKILL.md not found")
        return errors, warnings

    text = skill_md.read_text(encoding="utf-8")
    fm_text = extract_frontmatter(text)
    if fm_text is None:
        errors.append("SKILL.md is missing YAML frontmatter")
        return errors, warnings

    frontmatter = parse_yaml(fm_text)
    if not isinstance(frontmatter, dict):
        errors.append("Frontmatter could not be parsed as a map")
        return errors, warnings

    fm_errors, fm_warnings = validate_frontmatter(frontmatter)
    errors.extend(fm_errors)
    warnings.extend(fm_warnings)

    skill_name = str(frontmatter.get("name", "")).strip()
    if skill_name:
        yaml_errors, yaml_warnings = validate_openai_yaml(skill_path, skill_name)
        errors.extend(yaml_errors)
        warnings.extend(yaml_warnings)

    references_dir = skill_path / "references"
    if "references/" in text and not references_dir.exists():
        warnings.append("SKILL.md references 'references/' but folder is missing")

    scripts_dir = skill_path / "scripts"
    if scripts_dir.exists():
        python_scripts = sorted(scripts_dir.glob("*.py"))
        if not python_scripts:
            warnings.append("scripts/ exists but contains no Python scripts")

    return errors, warnings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Quick validation for skill folders")
    parser.add_argument("skill_dir", help="Path to skill directory")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    skill_path = Path(args.skill_dir).resolve()
    if not skill_path.exists() or not skill_path.is_dir():
        print(f"[FAIL] Skill directory not found: {skill_path}")
        return 1

    errors, warnings = validate_files(skill_path)

    if errors:
        print("[FAIL] Skill validation failed")
        for error in errors:
            print(f"  - {error}")
        if warnings:
            print("[WARN] Additional warnings:")
            for warning in warnings:
                print(f"  - {warning}")
        return 1

    print("[PASS] Skill validation succeeded")
    if warnings:
        print("[WARN] Warnings:")
        for warning in warnings:
            print(f"  - {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
