"""Round-trip test for SKILL.md parsing + frontmatter-preserving reassembly."""
from __future__ import annotations

import tempfile
from pathlib import Path

from skill_evolver.skill_module import load_skill, reassemble


SAMPLE = """---
name: my-skill
description: short description
category: memory
tags:
  - alpha
  - beta
---

# My Skill

Use this skill when the user asks about X.

## Workflow

1. do thing
2. do other thing
"""


def test_load_skill_round_trip() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        skill_path = Path(tmp) / "SKILL.md"
        skill_path.write_text(SAMPLE, encoding="utf-8")

        parsed = load_skill(skill_path)
        assert parsed.name == "my-skill"
        assert parsed.description == "short description"
        assert "# My Skill" in parsed.body
        assert "Workflow" in parsed.body

        reassembled = reassemble(parsed)
        assert "name: my-skill" in reassembled
        assert "description: short description" in reassembled
        assert reassembled.rstrip().endswith("2. do other thing")


def test_reassemble_overrides_description() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        skill_path = Path(tmp) / "SKILL.md"
        skill_path.write_text(SAMPLE, encoding="utf-8")
        parsed = load_skill(skill_path)

        updated = reassemble(parsed, description="new punchier description")
        assert "description: new punchier description" in updated
        assert "short description" not in updated
        assert "# My Skill" in updated


def test_reassemble_overrides_body() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        skill_path = Path(tmp) / "SKILL.md"
        skill_path.write_text(SAMPLE, encoding="utf-8")
        parsed = load_skill(skill_path)

        new_body = "# Rewritten\n\nnew content"
        updated = reassemble(parsed, body=new_body)
        assert "description: short description" in updated
        assert "# Rewritten" in updated
        assert "# My Skill" not in updated
