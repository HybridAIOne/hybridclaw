"""SKILL.md ↔ DSPy module adapter.

A SKILL.md has two optimizable surfaces:
- the `description:` field in frontmatter (controls triggering)
- the markdown body (controls execution behavior)

This module parses and re-assembles SKILL.md files while preserving all
other frontmatter fields. GEPA mutates one of those surfaces at a time.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


_FRONTMATTER_RE = re.compile(r"^---\n(?P<front>.*?)\n---\n?(?P<body>.*)$", re.DOTALL)


@dataclass
class ParsedSkill:
    path: Path
    raw: str
    frontmatter: str
    body: str
    name: str
    description: str
    extra_frontmatter: str = ""

    def describe(self) -> dict:
        return {
            "path": str(self.path),
            "name": self.name,
            "description": self.description,
            "body_bytes": len(self.body.encode("utf-8")),
            "description_chars": len(self.description),
        }


def _split_description_line(frontmatter: str) -> tuple[str, str]:
    """Return (description_value, remaining_frontmatter_without_description)."""
    description = ""
    out_lines: list[str] = []
    in_description_block = False
    for line in frontmatter.split("\n"):
        if in_description_block:
            if line.startswith(" ") or line.startswith("\t"):
                description += "\n" + line.strip()
                continue
            in_description_block = False
        m = re.match(r"^(description):\s*(.*)$", line)
        if m:
            value = m.group(2).strip()
            if value.startswith(">") or value.startswith("|"):
                in_description_block = True
                description = ""
                continue
            if value.startswith('"') and value.endswith('"') and len(value) >= 2:
                value = value[1:-1]
            elif value.startswith("'") and value.endswith("'") and len(value) >= 2:
                value = value[1:-1]
            description = value
            continue
        out_lines.append(line)
    remaining = "\n".join(out_lines).strip("\n")
    return description.strip(), remaining


def _extract_name(frontmatter: str) -> str:
    for line in frontmatter.split("\n"):
        m = re.match(r"^name:\s*(.*)$", line)
        if m:
            value = m.group(1).strip()
            if value.startswith('"') and value.endswith('"') and len(value) >= 2:
                value = value[1:-1]
            elif value.startswith("'") and value.endswith("'") and len(value) >= 2:
                value = value[1:-1]
            return value.strip()
    return ""


def load_skill(path: Path) -> ParsedSkill:
    raw = path.read_text(encoding="utf-8")
    match = _FRONTMATTER_RE.match(raw)
    if not match:
        return ParsedSkill(
            path=path,
            raw=raw,
            frontmatter="",
            body=raw,
            name=path.parent.name,
            description="",
        )
    frontmatter = match.group("front")
    body = match.group("body")
    name = _extract_name(frontmatter) or path.parent.name
    description, extra_frontmatter = _split_description_line(frontmatter)
    return ParsedSkill(
        path=path,
        raw=raw,
        frontmatter=frontmatter,
        body=body,
        name=name,
        description=description,
        extra_frontmatter=extra_frontmatter,
    )


def _escape_yaml_string(value: str) -> str:
    if "\n" in value:
        indented = "\n".join("  " + line for line in value.split("\n"))
        return f"|-\n{indented}"
    if ":" in value or value.startswith(("'", '"', "#", "-", "[", "{", "&", "*", "!", "|", ">", "%", "@", "`")):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def reassemble(skill: ParsedSkill, *, description: Optional[str] = None, body: Optional[str] = None) -> str:
    new_description = description if description is not None else skill.description
    new_body = body if body is not None else skill.body

    lines = skill.extra_frontmatter.split("\n") if skill.extra_frontmatter else []
    rendered: list[str] = []
    inserted = False

    for line in lines:
        if not inserted and re.match(r"^name:\s*", line):
            rendered.append(line)
            rendered.append(f"description: {_escape_yaml_string(new_description)}")
            inserted = True
            continue
        rendered.append(line)
    if not inserted:
        rendered.insert(0, f"description: {_escape_yaml_string(new_description)}")

    frontmatter_block = "\n".join(rendered).strip("\n")
    return f"---\n{frontmatter_block}\n---\n{new_body}"


__all__ = ["ParsedSkill", "load_skill", "reassemble"]
