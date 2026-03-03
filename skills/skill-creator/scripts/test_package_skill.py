#!/usr/bin/env python3
"""Regression tests for package_skill.py security behavior."""

from __future__ import annotations

import stat
import tempfile
import unittest
import zipfile
from pathlib import Path

from package_skill import SecurityError, package_skill, verify_archive


class PackageSkillTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tmpdir.name)

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _create_basic_skill(self, name: str = "demo-skill") -> Path:
        skill_dir = self.root / name
        (skill_dir / "scripts").mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: demo-skill\ndescription: Demo skill\n---\n\n# Demo\n",
            encoding="utf-8",
        )
        (skill_dir / "scripts" / "helper.py").write_text(
            "print('ok')\n",
            encoding="utf-8",
        )
        return skill_dir

    def test_package_success(self) -> None:
        skill_dir = self._create_basic_skill("demo-skill")
        archive = package_skill(skill_dir, output_dir=self.root)

        self.assertTrue(archive.exists())
        self.assertEqual(archive.suffix, ".skill")

        with zipfile.ZipFile(archive, "r") as zf:
            names = set(zf.namelist())

        self.assertIn("demo-skill/SKILL.md", names)
        self.assertIn("demo-skill/scripts/helper.py", names)

    def test_reject_symlink_in_input_tree(self) -> None:
        skill_dir = self._create_basic_skill("symlink-skill")
        outside = self.root / "outside.txt"
        outside.write_text("outside\n", encoding="utf-8")
        (skill_dir / "scripts" / "leak.py").symlink_to(outside)

        with self.assertRaises(SecurityError):
            package_skill(skill_dir, output_dir=self.root)

    def test_verify_archive_rejects_traversal(self) -> None:
        archive = self.root / "bad.skill"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("demo-skill/../evil.txt", "oops")

        with self.assertRaises(SecurityError):
            verify_archive(archive, "demo-skill")

    def test_verify_archive_rejects_symlink_entry(self) -> None:
        archive = self.root / "bad-symlink.skill"
        info = zipfile.ZipInfo("demo-skill/scripts/link.py")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16

        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr(info, "target")

        with self.assertRaises(SecurityError):
            verify_archive(archive, "demo-skill")


if __name__ == "__main__":
    unittest.main()
