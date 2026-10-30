"""Network-free image check with a real gateway, worker, and write tool.

Mount this file and check-provider.mjs read-only; use --network none and dummy
API keys. The provider fixture is never copied into production task images.
"""

import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    spec = importlib.util.spec_from_file_location("launcher", "/opt/wildclawbench/launch.py")
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)
    task = Path("/tmp_workspace")
    (task / "input.txt").write_text("Fixture input")
    os.environ["NODE_OPTIONS"] = "--import=/opt/wildclawbench/check-provider.mjs"
    sys.stdin = io.StringIO(json.dumps({
        "model": "openrouter/z-ai/glm-5", "prompt": "Fixture prompt", "timeout_seconds": 90,
    }))
    launcher.main()
    root = Path(os.environ["HYBRIDCLAW_DATA_DIR"])
    state = root / "data/agents/main/workspace"
    assert not state.is_symlink()
    assert (state / "SOUL.md").is_file()
    assert (state / ".hybridclaw").is_dir()
    assert sorted(p.name for p in task.iterdir()) == ["input.txt", "results"], sorted(p.name for p in task.iterdir())
    assert (task / "results/fixture.txt").read_text() == "Fixture artifact"
    result = json.loads((root / "completion.json").read_text())
    assert result["choices"][0]["message"]["content"] == "Fixture response"
    worker_env = dict(os.environ, HYBRIDCLAW_AGENT_SANDBOX_MODE="host",
                      HYBRIDCLAW_AGENT_WORKSPACE_ROOT="/tmp_workspace")
    preload = "/opt/wildclawbench/workspace-display.mjs"
    subprocess.run(["node", "--import", preload, "-e", "process.exit(0)"],
                   env=worker_env, check=True)
    worker_env["HYBRIDCLAW_AGENT_WORKSPACE_ROOT"] = "/tmp"
    refused = subprocess.run(["node", "--import", preload, "-e", "process.exit(0)"],
                             env=worker_env, capture_output=True)
    assert refused.returncode != 0, "Mismatched task root must fail closed"
    assert "gen-fixture-check" in (root / "data/gateway/generation-ids.log").read_text()
    print("PASS: real gateway/worker/tool, isolated agent state, task artifact, fence and generation observer; no network")


if __name__ == "__main__":
    main()
