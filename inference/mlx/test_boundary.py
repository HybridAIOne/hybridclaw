"""Pure boundary tests; no GPU, download or local account required."""
import json
import tempfile
import unittest
from pathlib import Path
from model_store import digest, validate_manifest, write_private
from server import validate_body, validate_profile
from trusted_architectures import SPARK_ARTIFACT, SPARK_AUTO_MAP, validate_model_code


class BoundaryTests(unittest.TestCase):
    def test_larger_context_requires_the_qualified_spark_artifact(self):
        profile = {"repo": SPARK_ARTIFACT[0], "revision": SPARK_ARTIFACT[1], "port": 8321,
                   "contextWindow": 40960, "maxTokens": 2048, "memoryLimitBytes": 7 * 1024**3,
                   "cacheBytes": 2 * 1024**3}
        validate_profile(profile)
        for override in [{"contextWindow": 40961}, {"contextWindow": True}, {"repo": "example/model"},
                         {"revision": "a" * 40}, {"maxTokens": 40961}, {"cacheBytes": 8 * 1024**3}]:
            with self.assertRaises(ValueError): validate_profile({**profile, **override})
        validate_profile({**profile, "repo": "example/model", "contextWindow": 8192})

    def test_packaged_spark_does_not_enable_arbitrary_checkpoint_code(self):
        config = {"model_type": "spark2_5", "auto_map": SPARK_AUTO_MAP}
        validate_model_code(config, {}, *SPARK_ARTIFACT)
        for altered, tokenizer, repo, revision in [
            (config, {}, "example/model", SPARK_ARTIFACT[1]),
            (config, {}, SPARK_ARTIFACT[0], "a" * 40),
            ({**config, "auto_map": {"AutoModel": "remote.Model"}}, {}, *SPARK_ARTIFACT),
            ({**config, "model_file": "custom.py"}, {}, *SPARK_ARTIFACT),
            (config, {"auto_map": {"AutoTokenizer": "custom.Tokenizer"}}, *SPARK_ARTIFACT),
            ({"model_file": "custom.py"}, {}, "example/model", "a" * 40),
        ]:
            with self.assertRaisesRegex(ValueError, "Remote"):
                validate_model_code(altered, tokenizer, repo, revision)

    def test_request_admission(self):
        body = {"model": "test-model", "messages": [{"role": "user", "content": "test"}], "max_tokens": 32}
        self.assertEqual(validate_body(body, "test-model", 64), body)
        for extra in [{"model": "other"}, {"draft_model": "remote/model"}, {"adapters": "../private"}, {"max_tokens": 65}, {"max_tokens": -1}, {"max_tokens": True}, {"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.com/image"}}]}]}, {"tools": [{"type": "function", "function": {"name": "bad/name"}}]}]:
            with self.assertRaises(ValueError):
                validate_body({**body, **extra}, "test-model", 64)

    def test_manifest_integrity_and_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, value in {"config.json": {}, "tokenizer.json": {}, "tokenizer_config.json": {"chat_template": "test"}, "model.safetensors": {}}.items():
                write_private(root / name, value)
            manifest = {"version": 1, "revision": "a" * 40, "license": "apache-2.0", "quantization": {"bits": 4}, "files": {p.name: digest(p) for p in root.iterdir()}}
            validate_manifest(manifest, root)
            (root / "untracked.py").write_text("test")
            with self.assertRaises(ValueError): validate_manifest(manifest, root)
            (root / "untracked.py").unlink()
            bad = {**manifest, "files": {**manifest["files"], "../outside": "a" * 64}}
            with self.assertRaises(ValueError): validate_manifest(bad, root)
            (root / "model.safetensors").write_text("changed")
            with self.assertRaises(ValueError): validate_manifest(manifest, root)

    def test_rejects_remote_code_even_when_checksummed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, value in {"config.json": {"auto_map": {"AutoModel": "custom.Model"}}, "tokenizer.json": {}, "tokenizer_config.json": {"chat_template": "test"}, "model.safetensors": {}}.items():
                (root / name).write_text(json.dumps(value))
            manifest = {"version": 1, "revision": "a" * 40, "license": "apache-2.0", "quantization": {"bits": 4}, "files": {p.name: digest(p) for p in root.iterdir()}}
            with self.assertRaisesRegex(ValueError, "Remote"): validate_manifest(manifest, root)


if __name__ == "__main__": unittest.main()
