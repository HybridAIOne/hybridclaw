"""Pinned model installation. Serving never downloads code or mutable revisions."""

import hashlib
import json
import os
import re
from pathlib import Path
from trusted_architectures import validate_model_code


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def write_private(path, value):
    temporary = path.with_suffix(".tmp")
    with open(temporary, "w", opener=lambda p, f: os.open(p, f, 0o600)) as handle:
        json.dump(value, handle, indent=2)
    temporary.replace(path)


def validate_manifest(manifest, root, verify=True):
    if manifest.get("version") != 1 or not re.fullmatch(r"[a-f0-9]{40}", manifest.get("revision", "")):
        raise ValueError("Model revision must be an immutable commit")
    files = manifest.get("files", {})
    if not {"config.json", "tokenizer_config.json", "tokenizer.json"} <= files.keys():
        raise ValueError("Model is missing pinned configuration or tokenizer")
    if not any(name.endswith(".safetensors") for name in files):
        raise ValueError("Model is missing pinned weights")
    if not manifest.get("license") or not manifest.get("quantization"):
        raise ValueError("Model license and quantization must be recorded")
    for name, checksum in files.items():
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or not re.fullmatch(r"[a-f0-9]{64}", checksum):
            raise ValueError("Invalid manifest path or checksum")
        target = root / relative
        if target.is_symlink() or not target.is_file() or not target.resolve().is_relative_to(root.resolve()):
            raise ValueError("Model file is missing or outside the installation")
        if verify and digest(target) != checksum:
            raise ValueError("Model integrity check failed; reinstall the checkpoint")
    # The loader must not see unpinned executable/model files alongside the manifest.
    actual = {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() and ".cache" not in p.parts}
    if actual != set(files):
        raise ValueError("Unexpected files in the model installation")
    config = json.loads((root / "config.json").read_text())
    tokenizer = json.loads((root / "tokenizer_config.json").read_text())
    validate_model_code(config, tokenizer, manifest.get("repo"), manifest.get("revision"))
    if not tokenizer.get("chat_template") and "chat_template.jinja" not in files:
        raise ValueError("A pinned chat template is required")


def install(profile, destination):
    from huggingface_hub import snapshot_download

    if not re.fullmatch(r"[a-f0-9]{40}", profile["revision"]):
        raise ValueError("An immutable model revision is required")
    root = destination / "models" / profile["revision"]
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    snapshot_download(
        repo_id=profile["repo"], revision=profile["revision"], local_dir=root,
        allow_patterns=["*.safetensors", "*.json", "*.jinja", "*.txt", "*.model", "README.md", "*LICENSE*", "NOTICE*"],
        ignore_patterns=["*.py", "*.bin", "*.pt", "*.pth", "*.gguf"],
    )
    config = json.loads((root / "config.json").read_text())
    manifest = {
        "version": 1, "repo": profile["repo"], "revision": profile["revision"],
        "license": profile["license"], "quantization": config.get("quantization"),
        "files": {str(p.relative_to(root)): digest(p) for p in root.rglob("*") if p.is_file() and ".cache" not in p.parts},
    }
    validate_manifest(manifest, root)
    write_private(destination / "manifest.json", manifest)
    return root


if __name__ == "__main__":
    import sys
    destination = Path(sys.argv[1])
    profile = json.loads(sys.stdin.read())
    print(install(profile, destination))
