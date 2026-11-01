"""Offline adapter lifecycle checks; no Docker, credentials, or model calls."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import evidence
import launch


class RunnerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wcb-runner-contract-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / "output"
        self.output.mkdir()
        base = ModuleType("src.agents.base")
        base.BaseAgent = object
        base.AgentExecution = SimpleNamespace
        utils = ModuleType("src.utils.docker_utils")
        utils.TMP_WORKSPACE = "/tmp_workspace"
        for name in ("_copy_changed_workspace_outputs_from_container", "run_warmup",
                     "setup_skills", "snapshot_workspace_state"):
            setattr(utils, name, Mock())
        transcript = ModuleType("src.utils.transcript_loader")
        transcript.OPENCLAW_FALLBACK_PATH = "/tmp/test-transcript.jsonl"
        spec = importlib.util.spec_from_file_location(
            "test_adapter.runner", Path(__file__).with_name("runner.py"))
        self.runner = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {
            "src.agents.base": base, "src.utils.docker_utils": utils,
            "src.utils.transcript_loader": transcript, "test_adapter.evidence": evidence, "test_adapter.launch": launch,
        }):
            spec.loader.exec_module(self.runner)

    def run_task(self, task, completion=None, returncode=0, expected_error=None):
        labels = json.dumps({"org.opencontainers.image.revision": "a" * 40,
                             "org.opencontainers.image.version": "0.0.0"})
        docker = Mock(side_effect=lambda *args: labels if args[-1] == "{{json .Config.Labels}}"
                      else json.dumps(completion or {"choices": [{"message": {"content": "Done"}}]})
                      if args[-1].endswith("/completion.json") else "sha256:test-image")
        process = Mock(returncode=returncode)
        spec = SimpleNamespace(
            lobster=False, models_config=None, thinking=None,
            model=next(iter(self.runner.MANIFEST["models"])), task_id="test-task",
            task=task, workspace_path=self.root, output_dir=self.output,
            timeout_seconds=60, prompt="Create the requested deliverable.",
        )
        with patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key",
                                       "BRAVE_API_KEY": "test-key",
                                       "JUDGE_MODEL": "openai/gpt-5.4"}), \
                patch.object(self.runner, "docker", docker), \
                patch.object(self.runner.subprocess, "Popen", return_value=process):
            result = self.runner.HybridClawAgent("https://example.com").run_task(spec)
        self.assertEqual(result.error, expected_error)
        self.runner.run_warmup.assert_called_once()
        self.runner.snapshot_workspace_state.assert_called_once_with("test-task")
        process.communicate.assert_called_once_with(json.dumps({
            "model": spec.model, "prompt": spec.prompt, "timeout_seconds": 60,
        }))
        return docker

    def test_approval_stop_is_reported_and_partial_outputs_remain_gradable(self):
        self.run_task({}, {"choices": [{}], "hybridclaw": {"pendingApproval": {
            "approvalId": "approval_a", "toolName": "bash", "expiresAt": None}}})
        execution = json.loads((self.output / "execution.json").read_text())
        self.assertEqual(execution["status"], "awaiting_approval")
        self.assertEqual(execution["pending_approval"]["approvalId"], "approval_a")

    def test_completion_and_timeout_are_separate_outcomes(self):
        self.run_task({})
        self.assertEqual(json.loads((self.output / "execution.json").read_text())["status"], "completed")
        self.runner.run_warmup.reset_mock()
        self.runner.snapshot_workspace_state.reset_mock()
        self.run_task({}, returncode=124)
        self.assertEqual(json.loads((self.output / "execution.json").read_text())["status"], "timed_out")

    def test_invalid_completion_is_not_reported_as_completed(self):
        self.run_task({}, {"invalid": True}, expected_error=
                      "Task-local HybridClaw completion metadata is unavailable or invalid")
        self.assertEqual(json.loads((self.output / "execution.json").read_text())["status"], "failed")

    def test_missing_empty_and_whitespace_skills_never_invoke_directory_setup(self):
        for task in ({}, {"skills": ""}, {"skills": " \n\t\n"}):
            with self.subTest(task=task):
                self.runner.run_warmup.reset_mock()
                self.runner.snapshot_workspace_state.reset_mock()
                docker = self.run_task(task)
                self.runner.setup_skills.assert_not_called()
                self.assertFalse(any("/tmp_workspace/skills" in str(call)
                                     for call in docker.call_args_list))

    def test_task_skills_keep_upstream_installation_and_precede_workspace_snapshot(self):
        skills = "\n examples/table-skill \n examples/document-skill\n"
        lifecycle = Mock()
        lifecycle.attach_mock(self.runner.setup_skills, "skills")
        lifecycle.attach_mock(self.runner.run_warmup, "warmup")
        lifecycle.attach_mock(self.runner.snapshot_workspace_state, "snapshot")
        self.run_task({"skills": skills, "skills_path": "/example/task-skills"})
        self.runner.setup_skills.assert_called_once_with(
            "test-task", skills, "/example/task-skills",
            container_skills_root="/tmp_workspace/skills")
        self.assertEqual([call[0] for call in lifecycle.mock_calls],
                         ["skills", "warmup", "snapshot"])


if __name__ == "__main__":
    unittest.main()
