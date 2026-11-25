"""Adapter contract tests against the real Harbor and OpenEnv classes.

No sandbox, model or network: the environment is a recording fake.
Run with a Python that has `openenv[harbor]` installed:
    python -m unittest discover -s eval-harness/harbor-adapter -v
"""

import asyncio
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hybridclaw_harbor  # noqa: E402
from harbor.agents.factory import AgentFactory  # noqa: E402
from harbor.models.agent.context import AgentContext  # noqa: E402
from openenv.harbor import capabilities, rollout, seams  # noqa: E402

INTERCEPT = {
    "base_url": "http://proxy.test:8300",
    "api_key": "session-key",
    "model": "Example-27B",
}


class FakeEnvironment:
    def __init__(self, return_code=0, result=None, fail_downloads=False):
        self.return_code = return_code
        self.result = result
        self.fail_downloads = fail_downloads
        self.uploads = {}
        self.commands = []

    async def upload_file(self, source, target):
        self.uploads[target] = Path(source).read_bytes()

    async def exec(self, command, env=None, timeout_sec=None):
        self.commands.append((command, env or {}))
        return SimpleNamespace(stdout="out", stderr="", return_code=self.return_code)

    async def download_file(self, source, target):
        if self.fail_downloads:
            raise RuntimeError("sandbox is gone")
        if source.endswith("hybridclaw-result.json") and self.result is not None:
            Path(target).write_text(json.dumps(self.result))
        else:
            Path(target).write_text("")


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.logs = root / "logs"
        self.logs.mkdir()
        self.archive = root / "hybridclaw-runtime.tgz"
        self.archive.write_bytes(b"runtime")
        self.write_manifest(hashlib.sha256(b"runtime").hexdigest())
        patch = mock.patch.dict(
            os.environ, {hybridclaw_harbor.RUNTIME_ENV: str(self.archive)}
        )
        patch.start()
        self.addCleanup(patch.stop)
        os.environ.pop(hybridclaw_harbor.CONTEXT_WINDOW_ENV, None)
        os.environ.pop(hybridclaw_harbor.SYSTEM_WRITES_ENV, None)

    def write_manifest(self, sha256):
        self.archive.with_suffix(".json").write_text(
            json.dumps({"version": "1.2.3", "sha256": sha256})
        )

    def agent(self, intercept=INTERCEPT):
        return hybridclaw_harbor.HybridClaw(
            logs_dir=self.logs, intercept_config=intercept
        )

    def test_openenv_builds_the_agent_through_the_registered_seam(self):
        with mock.patch.dict(seams.SEAMS):
            hybridclaw_harbor.register()
            self.assertIn(
                "hybridclaw", [h.name for h in capabilities.list_harnesses()]
            )
            config = rollout.build_trial_config(
                task_dir=self.tmp.name,
                harness="hybridclaw",
                sandbox="docker",
                intercept_url="http://proxy.test:8300",
                session_id="session-key",
                model="Example/Example-27B",
                trial_name="trial",
                trials_dir=self.tmp.name,
            )
        agent = AgentFactory.create_agent_from_config(config.agent, logs_dir=self.logs)
        self.assertIsInstance(agent, hybridclaw_harbor.HybridClaw)
        self.assertEqual(
            agent.run_config("task"),
            {
                "baseUrl": "http://proxy.test:8300/v1",
                "apiKey": "session-key",
                "model": "Example-27B",
                "version": "1.2.3",
                "traceDir": "/logs/agent",
                "instruction": "task",
            },
        )

    def test_direct_exposure_advertises_the_configured_proxy_host(self):
        from openenv.core.harness.capture import forwarding

        with (
            mock.patch.dict(seams.SEAMS),
            mock.patch.dict(forwarding._FORWARDERS),
            mock.patch.dict(
                os.environ, {hybridclaw_harbor.PROXY_HOST_ENV: "host.docker.internal"}
            ),
        ):
            hybridclaw_harbor.register()
            self.assertEqual(
                forwarding.make_forwarder("direct").start(8100),
                "http://host.docker.internal:8100",
            )

    def test_context_window_comes_from_the_server_environment(self):
        with mock.patch.dict(
            os.environ, {hybridclaw_harbor.CONTEXT_WINDOW_ENV: "32768"}
        ):
            self.assertEqual(self.agent().run_config()["contextWindow"], 32768)

    def test_system_writes_reject_an_unverified_environment(self):
        environment = FakeEnvironment()
        with mock.patch.dict(
            os.environ, {hybridclaw_harbor.SYSTEM_WRITES_ENV: "1"}
        ), self.assertRaises(hybridclaw_harbor.HybridClawSetupError):
            asyncio.run(self.agent().upload_run_config(environment, "task"))
        self.assertEqual(environment.uploads, {})

    def test_system_writes_require_inspected_docker_isolation(self):
        environment = mock.MagicMock(spec=hybridclaw_harbor.DockerEnvironment)
        environment._uses_compose = False
        environment._run_docker_compose_command.return_value = SimpleNamespace(
            stdout="a" * 64
        )
        host = {
            "Privileged": False, "CapAdd": None, "Devices": [], "DeviceRequests": None,
            "VolumesFrom": None, "PidMode": "", "IpcMode": "private", "UTSMode": "",
            "NetworkMode": "trial_default",
        }
        cases = [
            ([], host, True),
            ([{"Type": "bind"}], host, False),
            ([], {**host, "Privileged": True}, False),
            ([], {**host, "PidMode": "host"}, False),
            ([], {**host, "NetworkMode": "container:test"}, False),
        ]
        for mounts, config, allowed in cases:
            with self.subTest(mounts=mounts, config=config), mock.patch.object(
                hybridclaw_harbor.subprocess,
                "run",
                return_value=SimpleNamespace(
                    stdout=json.dumps({"mounts": mounts, "host": config})
                ),
            ):
                if allowed:
                    asyncio.run(hybridclaw_harbor.require_isolated_docker(environment))
                else:
                    with self.assertRaises(hybridclaw_harbor.HybridClawSetupError):
                        asyncio.run(hybridclaw_harbor.require_isolated_docker(environment))

    def test_missing_endpoint_fails_instead_of_using_a_default_provider(self):
        for missing in INTERCEPT:
            with self.subTest(missing=missing):
                partial = {k: v for k, v in INTERCEPT.items() if k != missing}
                with self.assertRaises(ValueError):
                    self.agent(partial).run_config()

    def test_missing_runtime_variable_fails_at_construction(self):
        with mock.patch.dict(os.environ):
            del os.environ[hybridclaw_harbor.RUNTIME_ENV]
            with self.assertRaises(hybridclaw_harbor.HybridClawSetupError):
                self.agent()

    def test_setup_uploads_the_runtime_and_runs_the_preflight(self):
        environment = FakeEnvironment()
        asyncio.run(self.agent().setup(environment))
        self.assertEqual(environment.uploads["/tmp/hybridclaw-runtime.tgz"], b"runtime")
        self.assertIn(hybridclaw_harbor.TASK_RUNNER, environment.uploads)
        uploaded = json.loads(environment.uploads[hybridclaw_harbor.RUN_CONFIG])
        self.assertEqual(uploaded["apiKey"], "session-key")
        command, env = environment.commands[0]
        self.assertIn("--check", command)
        self.assertEqual(env["HYBRIDCLAW_DATA_DIR"], "/opt/hybridclaw-check")
        self.assertEqual((self.logs / "install.log").read_text(), "out")

    def test_session_key_is_not_left_in_the_host_logs(self):
        asyncio.run(self.agent().setup(FakeEnvironment()))
        for path in self.logs.rglob("*"):
            if path.is_file():
                self.assertNotIn("session-key", path.read_text())

    def test_setup_rejects_an_archive_that_does_not_match_its_manifest(self):
        self.write_manifest("0" * 64)
        environment = FakeEnvironment()
        with self.assertRaises(hybridclaw_harbor.HybridClawSetupError):
            asyncio.run(self.agent().setup(environment))
        self.assertEqual(environment.uploads, {})

    def test_setup_fails_when_the_preflight_fails(self):
        with self.assertRaises(hybridclaw_harbor.HybridClawSetupError):
            asyncio.run(self.agent().setup(FakeEnvironment(return_code=1)))

    def test_run_reports_usage_and_native_status(self):
        environment = FakeEnvironment(
            result={
                "status": "success",
                "tokenUsage": {
                    "apiPromptTokens": 11,
                    "apiCompletionTokens": 7,
                    "apiCacheReadTokens": 3,
                },
            }
        )
        context = AgentContext()
        asyncio.run(self.agent().run("do the task", environment, context))
        uploaded = json.loads(environment.uploads[hybridclaw_harbor.RUN_CONFIG])
        self.assertEqual(uploaded["instruction"], "do the task")
        _, env = environment.commands[0]
        self.assertEqual(env["HYBRIDCLAW_DATA_DIR"], hybridclaw_harbor.STATE_DIR)
        self.assertIn("/usr/sbin", env["PATH"].split(":"))
        self.assertIn("/sbin", env["PATH"].split(":"))
        self.assertEqual(
            (context.n_input_tokens, context.n_output_tokens, context.n_cache_tokens),
            (11, 7, 3),
        )
        self.assertEqual(context.metadata["nativeStatus"], "success")

    def test_run_raises_after_a_native_error(self):
        environment = FakeEnvironment(
            return_code=1, result={"status": "error", "error": "boom"}
        )
        context = AgentContext()
        with self.assertRaises(hybridclaw_harbor.HybridClawExecutionError):
            asyncio.run(self.agent().run("task", environment, context))
        self.assertEqual(context.metadata["nativeError"], "boom")

    def test_failed_trace_collection_is_recorded_not_raised(self):
        agent = self.agent()
        asyncio.run(agent.collect_traces(FakeEnvironment(fail_downloads=True)))
        errors = json.loads((self.logs / "trace-collection-errors.json").read_text())
        self.assertEqual(len(errors), 2)


if __name__ == "__main__":
    unittest.main()
