"""Pure boundary tests; no GPU, download or local account required."""
import json
import tempfile
import unittest
from pathlib import Path
from model_store import digest, validate_manifest, write_private
from server import ContextBudgetError, GeneratedToolCallError, generation_error, preparation_error, validate_body, resolve_output_budget, validate_generated_tool_calls, validate_profile
from trusted_architectures import SPARK_ARTIFACT, SPARK_AUTO_MAP, validate_model_code


class BoundaryTests(unittest.TestCase):
    def test_output_uses_remaining_exact_context_without_a_short_reasoning_cap(self):
        self.assertEqual(resolve_output_budget(22533, 40960, 40960, 2), 18427)
        self.assertEqual(resolve_output_budget(40959, 40960, 40960, 2), 1)
        self.assertEqual(resolve_output_budget(100, 4096, 4096, 10), 3996)

    def test_explicit_request_caps_are_honored_within_remaining_context(self):
        self.assertEqual(resolve_output_budget(100, 32, 40960, 2), 32)
        self.assertEqual(resolve_output_budget(40950, 512, 40960, 2), 10)

    def test_full_or_overflowing_prompts_fail_before_generation(self):
        for prompt_tokens in [40960, 50649]:
            with self.assertRaises(ContextBudgetError) as caught:
                resolve_output_budget(prompt_tokens, 40960, 40960, 114)
            error = preparation_error(caught.exception)
            self.assertIs(error, caught.exception)
            self.assertIn(f"{prompt_tokens} prompt tokens + 1 output tokens > 40960 tokens (114 tools)", str(error))
            self.assertIn("Reduce instructions or enabled tools", str(error))

    def test_preparation_errors_do_not_expose_library_messages_or_guess_overflow(self):
        for original in [ValueError("private prompt text"), RuntimeError("private schema text"), KeyError("private field")]:
            error = preparation_error(original)
            self.assertNotIn("private", str(error))
            self.assertNotIn("context limit exceeded", str(error))
            self.assertIn("messages and tool definitions", str(error))
        error = preparation_error(MemoryError("private allocation context"))
        self.assertIn("ran out of memory", str(error))
        self.assertNotIn("private", str(error))

    def test_generated_calls_preserve_the_exposed_schema_boundary(self):
        for key in ["message", "delta"]:
            def response(name, arguments):
                return {"choices": [{key: {"tool_calls": [{"function": {
                    "name": name, "arguments": arguments,
                }}]}}]}
            validate_generated_tool_calls(response("tool_catalog", '{"action":"list"}'), {"tool_catalog"})
            with self.assertRaises(GeneratedToolCallError) as caught:
                validate_generated_tool_calls(response("private-tool-name", '{"path":"private-path"}'), {"tool_catalog"})
            message = generation_error(caught.exception)
            self.assertIn("not exposed", message)
            self.assertIn("tool_catalog", message)
            self.assertNotIn("private", message)
            for arguments in ['{"private":', '[]', 'null', '"private"', None, {}]:
                with self.assertRaises(GeneratedToolCallError) as caught:
                    validate_generated_tool_calls(response("tool_catalog", arguments), {"tool_catalog"})
                self.assertIn("invalid tool arguments", generation_error(caught.exception))
                self.assertNotIn("private", generation_error(caught.exception))
            validate_generated_tool_calls({"choices": [{key: {"content": "hello"}}]}, set())

    def test_generation_error_categories_never_expose_library_payloads(self):
        for error in [ValueError("private output"), KeyError("private field"), RuntimeError("private kernel")]:
            self.assertEqual(generation_error(error), "Local inference failed; check the local model runtime.")
        self.assertIn("ran out of memory", generation_error(MemoryError("private allocation")))
        self.assertNotIn("private", generation_error(MemoryError("private allocation")))

    def test_larger_context_requires_the_qualified_spark_artifact(self):
        profile = {"repo": SPARK_ARTIFACT[0], "revision": SPARK_ARTIFACT[1], "port": 8321,
                   "contextWindow": 40960, "memoryLimitBytes": 7 * 1024**3,
                   "cacheBytes": 2 * 1024**3}
        validate_profile(profile)
        for override in [{"contextWindow": 40961}, {"contextWindow": True}, {"repo": "example/model"},
                         {"revision": "a" * 40}, {"cacheBytes": 8 * 1024**3}]:
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

    def test_output_request_budget_accepts_long_generation_and_rejects_invalid_caps(self):
        body = {"model": "test-model", "messages": [{"role": "user", "content": "test"}]}
        self.assertEqual(validate_body(body, "test-model", 40960), body)
        for key in ["max_tokens", "max_completion_tokens"]:
            for cap in [4096, 18427, 40960]:
                request = {**body, key: cap}
                self.assertEqual(validate_body(request, "test-model", 40960), request)
            for cap in [None, True, 0, -1, 1.5, "4096", 40961]:
                with self.assertRaises(ValueError):
                    validate_body({**body, key: cap}, "test-model", 40960)
        with self.assertRaises(ValueError):
            validate_body({**body, "max_tokens": -1, "max_completion_tokens": 64}, "test-model", 40960)

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
