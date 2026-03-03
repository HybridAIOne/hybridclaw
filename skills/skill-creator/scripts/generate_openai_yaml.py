#!/usr/bin/env python3
"""
Generate agents/openai.yaml for a skill folder.

Usage:
    python3 scripts/generate_openai_yaml.py <skill_dir> [--name <skill-name>] [--interface key=value]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

ACRONYMS = {
    "API",
    "CLI",
    "CI",
    "GH",
    "JSON",
    "LLM",
    "MCP",
    "PDF",
    "PR",
    "SQL",
    "UI",
    "URL",
    "YAML",
}

BRAND_WORDS = {
    "github": "GitHub",
    "openai": "OpenAI",
    "openapi": "OpenAPI",
    "sqlite": "SQLite",
    "postgresql": "PostgreSQL",
    "fastapi": "FastAPI",
}

SMALL_WORDS = {"and", "or", "to", "with", "for", "of"}

ALLOWED_INTERFACE_KEYS = {
    "display_name",
    "short_description",
    "icon_small",
    "icon_large",
    "brand_color",
    "default_prompt",
}

INTERFACE_WRITE_ORDER = [
    "display_name",
    "short_description",
    "icon_small",
    "icon_large",
    "brand_color",
    "default_prompt",
]


def yaml_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'"{escaped}"'


def normalize_skill_name(raw: str) -> str:
    value = raw.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    return value


def format_display_name(skill_name: str) -> str:
    words = [w for w in skill_name.split("-") if w]
    parts: List[str] = []
    for idx, word in enumerate(words):
        upper = word.upper()
        lower = word.lower()
        if upper in ACRONYMS:
            parts.append(upper)
            continue
        if lower in BRAND_WORDS:
            parts.append(BRAND_WORDS[lower])
            continue
        if idx > 0 and lower in SMALL_WORDS:
            parts.append(lower)
            continue
        parts.append(lower.capitalize())
    return " ".join(parts)


def generate_short_description(display_name: str) -> str:
    candidates = [
        f"Create and maintain {display_name}",
        f"Help with {display_name} workflows",
        f"{display_name} skill helper",
    ]
    for candidate in candidates:
        if 25 <= len(candidate) <= 64:
            return candidate

    # Final bounded fallback.
    fallback = f"Help with {display_name} tasks"
    if len(fallback) > 64:
        fallback = fallback[:64].rstrip()
    if len(fallback) < 25:
        fallback = f"{fallback} workflows"
        if len(fallback) > 64:
            fallback = fallback[:64].rstrip()
    return fallback


def generate_default_prompt(skill_name: str, display_name: str) -> str:
    return f"Use ${skill_name} to help with {display_name.lower()} tasks."


def parse_frontmatter_name(skill_dir: Path) -> Optional[str]:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        print(f"[ERROR] SKILL.md not found in {skill_dir}")
        return None

    text = skill_md.read_text(encoding="utf-8")
    match = re.match(r"^---\n([\s\S]*?)\n---", text)
    if not match:
        print("[ERROR] SKILL.md is missing YAML frontmatter")
        return None

    block = match.group(1)
    for line in block.splitlines():
        m = re.match(r"^name\s*:\s*(.+)$", line.strip())
        if not m:
            continue
        value = m.group(1).strip().strip('"').strip("'")
        if value:
            return normalize_skill_name(value)

    print("[ERROR] SKILL.md frontmatter is missing a valid 'name' field")
    return None


def parse_interface_overrides(raw_values: Sequence[str]) -> Tuple[Optional[Dict[str, str]], Optional[List[str]]]:
    values: Dict[str, str] = {}
    user_order: List[str] = []

    for item in raw_values:
        if "=" not in item:
            print(f"[ERROR] Invalid interface override '{item}'. Use key=value format.")
            return None, None

        key, value = item.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key not in ALLOWED_INTERFACE_KEYS:
            allowed = ", ".join(sorted(ALLOWED_INTERFACE_KEYS))
            print(f"[ERROR] Unknown interface field '{key}'. Allowed fields: {allowed}")
            return None, None

        values[key] = value
        if key not in user_order:
            user_order.append(key)

    return values, user_order


def validate_interface(interface: Dict[str, str], skill_name: str) -> bool:
    short_description = interface.get("short_description", "")
    if not (25 <= len(short_description) <= 64):
        print(
            "[ERROR] interface.short_description must be 25-64 characters "
            f"(got {len(short_description)})."
        )
        return False

    brand_color = interface.get("brand_color")
    if brand_color and not re.match(r"^#[0-9A-Fa-f]{6}$", brand_color):
        print("[ERROR] interface.brand_color must be a 6-digit hex color like #0B6E4F")
        return False

    default_prompt = interface.get("default_prompt")
    if default_prompt and f"${skill_name}" not in default_prompt:
        print(
            "[ERROR] interface.default_prompt must explicitly mention "
            f"${skill_name}"
        )
        return False

    return True


def write_openai_yaml(
    skill_dir: Path,
    skill_name: str,
    interface_overrides: Sequence[str],
) -> Optional[Path]:
    overrides, _ = parse_interface_overrides(interface_overrides)
    if overrides is None:
        return None

    display_name = overrides.get("display_name") or format_display_name(skill_name)
    short_description = overrides.get("short_description") or generate_short_description(display_name)
    default_prompt = overrides.get("default_prompt") or generate_default_prompt(skill_name, display_name)

    interface: Dict[str, str] = {
        "display_name": display_name,
        "short_description": short_description,
        "default_prompt": default_prompt,
    }

    for field in ("icon_small", "icon_large", "brand_color"):
        if field in overrides:
            interface[field] = overrides[field]

    if not validate_interface(interface, skill_name):
        return None

    lines = ["interface:"]
    for key in INTERFACE_WRITE_ORDER:
        if key not in interface:
            continue
        lines.append(f"  {key}: {yaml_quote(interface[key])}")

    output_dir = skill_dir / "agents"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "openai.yaml"
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"[OK] Wrote {output_path}")
    return output_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate agents/openai.yaml for a skill")
    parser.add_argument("skill_dir", help="Path to skill directory")
    parser.add_argument(
        "--name",
        help="Skill name override (defaults to SKILL.md frontmatter name)",
    )
    parser.add_argument(
        "--interface",
        action="append",
        default=[],
        help="Interface override in key=value format (repeatable)",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    skill_dir = Path(args.skill_dir).resolve()
    if not skill_dir.exists():
        print(f"[ERROR] Skill directory not found: {skill_dir}")
        return 1
    if not skill_dir.is_dir():
        print(f"[ERROR] Path is not a directory: {skill_dir}")
        return 1

    skill_name = normalize_skill_name(args.name) if args.name else parse_frontmatter_name(skill_dir)
    if not skill_name:
        return 1

    result = write_openai_yaml(skill_dir, skill_name, args.interface)
    return 0 if result else 1


if __name__ == "__main__":
    sys.exit(main())
