"""One isolated HybridClaw gateway per task; never talks to the host gateway."""

import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time
import urllib.request


def completion_outcome(result):
    """Use gateway metadata, never assistant prose, to identify approval stops."""
    if not isinstance(result, dict) or not result.get("choices"):
        raise ValueError("Missing completion result")
    extension = result.get("hybridclaw", {})
    if not isinstance(extension, dict):
        raise ValueError("Invalid gateway execution metadata")
    if "pendingApproval" not in extension:
        return {"status": "completed"}
    approval = extension["pendingApproval"]
    if (not isinstance(approval, dict) or not isinstance(approval.get("approvalId"), str)
            or not approval["approvalId"] or "expiresAt" not in approval
            or (approval["expiresAt"] is not None
                and not isinstance(approval["expiresAt"], (int, float)))
            or ("toolName" in approval and not isinstance(approval["toolName"], str))):
        raise ValueError("Invalid gateway pending approval")
    return {"status": "awaiting_approval", "pending_approval": {
        key: approval[key] for key in ("approvalId", "toolName", "expiresAt") if key in approval}}


def main():
    payload = json.load(sys.stdin)
    root = Path(os.environ["HYBRIDCLAW_DATA_DIR"])
    root.mkdir(mode=0o700)  # Existing state is an integration error.
    token = secrets.token_urlsafe(32)
    model = payload["model"]
    config = {
        "openrouter": {"enabled": True, "models": [model]},
        "agents": {"defaults": {"model": model},
                   "list": [{"id": "main", "onboarding": False}]},
        "container": {"sandboxMode": "host", "timeoutMs": payload["timeout_seconds"] * 1000},
        "heartbeat": {"enabled": False},
        "observability": {"enabled": False},
        "web": {"search": {"provider": "brave"}},
        "ops": {"debugModelResponses": True},
    }
    (root / "config.json").write_text(json.dumps(config))
    home = Path("/tmp/hybridclaw-home")
    home.mkdir(mode=0o700)
    if Path("/tmp_workspace/skills").is_dir():
        config["skills"] = {"extraDirs": ["/tmp_workspace/skills"]}
        (root / "config.json").write_text(json.dumps(config))
    env = dict(os.environ, HOME=str(home),
               HYBRIDCLAW_EVAL_WORKSPACE_ROOT="/tmp_workspace", GATEWAY_API_TOKEN=token, WEB_API_TOKEN=token,
               HYBRIDCLAW_ACCEPT_TRUST="true",
               NODE_OPTIONS=(os.environ.get("NODE_OPTIONS", "") +
                             " --import=/opt/wildclawbench/workspace-display.mjs" +
                             " --import=/opt/wildclawbench/record-generations.mjs").strip())
    gateway = subprocess.Popen(
        ["node", "/opt/hybridclaw/dist/cli.js", "gateway", "start", "--foreground", "--sandbox=host"],
        env=env, start_new_session=True,
    )

    def stop(*_):
        if gateway.poll() is None:
            os.killpg(gateway.pid, signal.SIGTERM)

    def interrupted(*_):
        stop()
        raise TimeoutError("WildClawBench task deadline reached")

    signal.signal(signal.SIGTERM, interrupted)
    try:
        deadline = time.monotonic() + 60
        while True:
            if gateway.poll() is not None:
                raise RuntimeError("Task-local gateway exited during startup")
            try:
                with urllib.request.urlopen("http://127.0.0.1:9090/health", timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Task-local gateway did not become healthy") from None
                time.sleep(0.2)
        request = urllib.request.Request(
            "http://127.0.0.1:9090/v1/chat/completions",
            data=json.dumps({
                # Explicit profile enables existing eval auto-approval. A new
                # runtime already provides a fresh default agent and session.
                "model": model + "__hc_eval=current-agent",
                "messages": [{"role": "user", "content": payload["prompt"]}],
                "stream": False,
            }).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        )
        with urllib.request.urlopen(request, timeout=payload["timeout_seconds"]) as response:
            result = json.load(response)
        (root / "completion.json").write_text(json.dumps(result))
    finally:
        stop()
        try:
            gateway.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(gateway.pid, signal.SIGKILL)
            gateway.wait()


if __name__ == "__main__":
    main()
