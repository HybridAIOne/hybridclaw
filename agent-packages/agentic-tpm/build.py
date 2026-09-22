#!/usr/bin/env python3
"""Build a deterministic .claw archive from this package and its canonical skill."""
import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    package = Path(__file__).resolve().parent
    skill = package.parents[1] / "skills" / "agentic-tpm"
    manifest = json.loads((package / "manifest.json").read_text())
    if manifest["formatVersion"] != 1 or manifest["skills"]["bundled"] != [skill.name]:
        raise ValueError("Manifest must name the canonical agentic-tpm skill")
    files = [(package / "manifest.json", "manifest.json")]
    for root, prefix in [(package / "workspace", "workspace"),
                         (skill, "skills/agentic-tpm")]:
        for file in sorted(root.rglob("*")):
            if file.is_symlink():
                raise ValueError(f"Symlinks are not package content: {file}")
            if file.is_file():
                files.append((file, f"{prefix}/{file.relative_to(root).as_posix()}"))
    output = args.output.resolve()
    if output.is_relative_to(package) or output.is_relative_to(skill):
        raise ValueError("Output must be outside source directories")
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for file, name in files:
            info = ZipInfo(name, date_time=(2026, 9, 22, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, file.read_bytes())
    print(output)


if __name__ == "__main__":
    main()
