"""HybridClaw as a Harbor agent and an OpenEnv harness.

Runs a prebuilt HybridClaw gateway and worker inside the task sandbox and sends
every model call to the endpoint in `intercept_config`. Harbor owns task setup,
the deadline and the verifier; OpenEnv's capture proxy owns token capture.

`python hybridclaw_harbor.py <openenv args>` registers the `hybridclaw` seam and
then runs the stock `openenv` CLI, so `harbor serve` and `harbor rollout` accept
`--harness hybridclaw` without a patched OpenEnv.

It does NOT write an ATIF trajectory, so OpenEnv has no second record to check
its capture against; side calls are only excluded when its own conversation
graph discards them.
"""

import asyncio
import hashlib
import json
import os
import sys
from functools import partial
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

HERE = Path(__file__).resolve().parent
RUNTIME_ENV = "HYBRIDCLAW_HARBOR_RUNTIME"
CONTEXT_WINDOW_ENV = "HYBRIDCLAW_HARBOR_CONTEXT_WINDOW"
PROXY_HOST_ENV = "HYBRIDCLAW_HARBOR_PROXY_HOST"
NODE = "/opt/hybridclaw-node/bin/node"
TASK_RUNNER = "/tmp/hybridclaw-task.mjs"
RUN_CONFIG = "/tmp/hybridclaw-run.json"
STATE_DIR = "/opt/hybridclaw-state"


class HybridClawSetupError(RuntimeError):
    pass


class HybridClawExecutionError(RuntimeError):
    pass


def load_runtime() -> tuple[Path, dict[str, Any]]:
    """The runtime archive and the manifest `build-runtime.sh` wrote beside it."""
    configured = os.environ.get(RUNTIME_ENV)
    if not configured:
        raise HybridClawSetupError(
            f"{RUNTIME_ENV} must name the archive built by build-runtime.sh"
        )
    archive = Path(configured)
    manifest = json.loads(archive.with_suffix(".json").read_text())
    return archive, manifest


class HybridClaw(BaseAgent):
    def __init__(
        self, *args: Any, intercept_config: dict[str, str] | None = None, **kwargs: Any
    ):
        self._intercept = intercept_config or {}
        self._archive, self._manifest = load_runtime()
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "hybridclaw"

    def version(self) -> str:
        return self._manifest["version"]

    def run_config(self, instruction: str | None = None) -> dict[str, Any]:
        base_url = self._intercept.get("base_url")
        api_key = self._intercept.get("api_key")
        model = self._intercept.get("model")
        if not (base_url and api_key and model):
            # Without this HybridClaw would fall back to its default provider
            # and the rollout would be graded with no captured tokens.
            raise ValueError(
                "HybridClaw requires intercept_config with base_url, api_key, model"
            )
        config: dict[str, Any] = {
            "baseUrl": f"{base_url.rstrip('/')}/v1",
            "apiKey": api_key,
            "model": model,
            "version": self.version(),
            "traceDir": str(self.environment_logs_dir),
        }
        if os.environ.get(CONTEXT_WINDOW_ENV):
            config["contextWindow"] = int(os.environ[CONTEXT_WINDOW_ENV])
        if instruction is not None:
            config["instruction"] = instruction
        return config

    async def upload_run_config(
        self, environment: BaseEnvironment, instruction: str | None = None
    ) -> None:
        path = self.logs_dir / "hybridclaw-run.json"
        path.write_text(json.dumps(self.run_config(instruction)))
        try:
            await environment.upload_file(path, RUN_CONFIG)
        finally:
            # The session key must not stay in the trial's host-side logs.
            path.unlink()

    async def setup(self, environment: BaseEnvironment) -> None:
        digest = hashlib.sha256(self._archive.read_bytes()).hexdigest()
        if digest != self._manifest["sha256"]:
            raise HybridClawSetupError("Runtime archive does not match its manifest")
        await environment.upload_file(self._archive, "/tmp/hybridclaw-runtime.tgz")
        await environment.upload_file(HERE / "task-runner.mjs", TASK_RUNNER)
        await self.upload_run_config(environment)
        result = await environment.exec(
            # --no-same-owner: some sandboxes refuse the ownership changes tar makes.
            command=(
                "set -eu; tar --no-same-owner -xzf /tmp/hybridclaw-runtime.tgz -C /; "
                "rm /tmp/hybridclaw-runtime.tgz; "
                f"{NODE} {TASK_RUNNER} {RUN_CONFIG} --check"
            ),
            env={"HYBRIDCLAW_DATA_DIR": "/opt/hybridclaw-check"},
            timeout_sec=300,
        )
        (self.logs_dir / "install.log").write_text(
            (result.stdout or "") + (result.stderr or "")
        )
        if result.return_code:
            raise HybridClawSetupError("HybridClaw preflight failed; see install.log")

    async def collect_traces(self, environment: BaseEnvironment) -> None:
        errors = []
        # The audit trail and progress log are already in the agent log folder.
        for source, name in [
            ("/tmp/hybridclaw-process.log", "hybridclaw.log"),
            ("/tmp/hybridclaw-result.json", "hybridclaw-result.json"),
        ]:
            try:
                await asyncio.wait_for(
                    environment.download_file(source, self.logs_dir / name), timeout=10
                )
            except Exception as error:  # noqa: BLE001 - never mask the run's own error
                errors.append({"source": source, "error": str(error)})
        if errors:
            (self.logs_dir / "trace-collection-errors.json").write_text(
                json.dumps(errors, indent=2)
            )

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        await self.upload_run_config(environment, instruction)
        try:
            result = await environment.exec(
                command=(
                    f"{NODE} {TASK_RUNNER} {RUN_CONFIG} "
                    "> /tmp/hybridclaw-process.log 2>&1"
                ),
                env={
                    "PATH": "/opt/hybridclaw-node/bin:/usr/local/bin:/usr/bin:/bin",
                    "HYBRIDCLAW_DATA_DIR": STATE_DIR,
                },
            )
        finally:
            # Harbor cancels run() at its deadline, then removes the sandbox.
            await self.collect_traces(environment)
        output = json.loads((self.logs_dir / "hybridclaw-result.json").read_text())
        usage = output.get("tokenUsage") or {}
        context.n_input_tokens = usage.get("apiPromptTokens")
        context.n_output_tokens = usage.get("apiCompletionTokens")
        context.n_cache_tokens = usage.get("apiCacheReadTokens")
        context.metadata = {
            "nativeStatus": output.get("status"),
            "nativeError": output.get("error"),
        }
        if result.return_code:
            raise HybridClawExecutionError(
                "HybridClaw execution failed; see hybridclaw.log"
            )


def register() -> None:
    """Add the `hybridclaw` seam to this process's OpenEnv seam table."""
    from openenv.core.harness.capture import forwarding
    from openenv.harbor import seams

    proxy_host = os.environ.get(PROXY_HOST_ENV)
    if proxy_host:
        # `--expose direct` advertises 127.0.0.1, which is the sandbox itself
        # from inside a local Docker sandbox. OpenEnv 0.7.0 has no flag for it.
        forwarding._FORWARDERS["direct"] = partial(
            forwarding.DirectExposure, advertise_host=proxy_host
        )
    seams.SEAMS["hybridclaw"] = seams.Seam(
        name="hybridclaw",
        dialect="openai_chat",
        import_path="hybridclaw_harbor:HybridClaw",
        kwargs=lambda base_url, session, model: {
            "intercept_config": {
                "base_url": base_url,
                "api_key": session,
                "model": model,
            }
        },
        notes="Prebuilt runtime archive; no ATIF trajectory, no native step limit.",
    )


def main() -> None:
    # Harbor imports the agent by module name from the server process.
    sys.path.insert(0, str(HERE))
    register()
    from openenv.cli.__main__ import main as openenv_main

    openenv_main()


if __name__ == "__main__":
    main()
