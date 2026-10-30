"""WildClawBench BaseAgent adapter; task prompts and grading belong upstream."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

from src.agents.base import AgentExecution, BaseAgent
from src.utils.docker_utils import (
    TMP_WORKSPACE, _copy_changed_workspace_outputs_from_container,
    run_warmup, setup_skills, snapshot_workspace_state,
)
from src.utils.transcript_loader import OPENCLAW_FALLBACK_PATH
from .evidence import generation_ids, summarize_generations

RUNTIME = "/tmp/hybridclaw-runtime"
TRANSCRIPT = OPENCLAW_FALLBACK_PATH
MANIFEST = json.loads(Path(__file__).with_name("manifest.json").read_text())


def docker(*args, **kwargs):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, **kwargs)
    if result.returncode:
        # Docker output can contain task env values; keep errors payload-free.
        raise RuntimeError("Docker operation failed: " + args[0])
    return result.stdout


class HybridClawAgent(BaseAgent):
    expects_gateway = False
    transcript_container_path = TRANSCRIPT

    def __init__(self, openrouter_base_url):
        # Upstream grading injects task Env names from the host, overriding
        # container values even when absent. Keep its provider endpoint set.
        os.environ["OPENROUTER_BASE_URL"] = openrouter_base_url

    def run_task(self, spec):
        if spec.lobster or spec.models_config or spec.thinking is not None:
            raise ValueError("HybridClaw comparison requires the fresh default configuration")
        if TMP_WORKSPACE != "/tmp_workspace":
            raise ValueError("HybridClaw image requires TMP_WORKSPACE=/tmp_workspace")
        if not spec.model.startswith("openrouter/"):
            raise ValueError("Use openrouter/<provider>/<model>")
        if spec.model not in MANIFEST["models"]:
            raise ValueError("Model is outside the requested comparison")
        for key in ("OPENROUTER_API_KEY", "BRAVE_API_KEY"):
            if not os.environ.get(key):
                raise ValueError("Missing " + key)
        if os.environ.get("JUDGE_MODEL", "openai/gpt-5.4") != "openai/gpt-5.4":
            raise ValueError("The published comparison requires the default judge")
        env_names = ["OPENROUTER_API_KEY", "BRAVE_API_KEY", "JUDGE_MODEL"]
        env_names.extend(line.strip() for line in spec.task.get("env", "").splitlines()
                         if line.strip() and not line.strip().startswith("#"))
        env_args = [arg for name in dict.fromkeys(env_names) for arg in ("-e", name)]
        proc = None
        started = time.perf_counter()
        try:
            workspace = Path(spec.workspace_path)
            docker("run", "-d", "--name", spec.task_id, *env_args,
                   "-e", "OPENROUTER_BASE_URL",
                   "-v", str(workspace / "exec") + ":/app:ro",
                   MANIFEST["agent_image"],
                   "/bin/bash", "-c", "tail -f /dev/null")
            labels = json.loads(docker("inspect", spec.task_id, "--format", "{{json .Config.Labels}}"))
            revision = labels.get("org.opencontainers.image.revision", "")
            version = labels.get("org.opencontainers.image.version", "")
            if len(revision) != 40 or set(revision) - set("0123456789abcdef") or not version:
                raise ValueError("Image source provenance is missing; rebuild with build.sh")
            (spec.output_dir / "provenance.json").write_text(json.dumps({
                "wildclawbench_commit": MANIFEST["wildclawbench_commit"],
                "hybridclaw_baseline_commit": MANIFEST["hybridclaw_commit"],
                "hybridclaw_commit": revision, "hybridclaw_version": version,
                "image_id": docker("inspect", spec.task_id, "--format", "{{.Image}}").strip(),
                "model": spec.model, "judge_model": "openai/gpt-5.4",
                "timeout_seconds": spec.timeout_seconds,
                "prompt_sha256": hashlib.sha256(spec.prompt.encode()).hexdigest(),
            }, indent=2))
            docker("exec", spec.task_id, "/bin/bash", "-c",
                   "mkdir -p /tmp_workspace && cp -r /app/. /tmp_workspace && chmod -R u+w /tmp_workspace")
            if (workspace / "tmp").is_dir():
                docker("exec", spec.task_id, "mkdir", "-p", "/tmp_workspace/tmp")
                docker("cp", str(workspace / "tmp") + "/.", spec.task_id + ":/tmp_workspace/tmp/")
            setup_skills(spec.task_id, spec.task.get("skills", ""),
                         spec.task.get("skills_path", ""),
                         container_skills_root="/tmp_workspace/skills")
            run_warmup(spec.task_id, spec.task.get("warmup", ""))
            snapshot_workspace_state(spec.task_id)
            spec.output_dir.mkdir(parents=True, exist_ok=True)
            started = time.perf_counter()
            with (spec.output_dir / "agent.log").open("w") as log:
                proc = subprocess.Popen([
                    "docker", "exec", "-i", spec.task_id,
                    "timeout", "--signal=TERM", "--kill-after=10s", str(spec.timeout_seconds),
                    "python3", "/opt/wildclawbench/launch.py",
                ], stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, text=True)
                proc.communicate(json.dumps({"model": spec.model, "prompt": spec.prompt,
                                             "timeout_seconds": spec.timeout_seconds}))
            elapsed = min(time.perf_counter() - started, spec.timeout_seconds)
            # Upstream Hermes grades whatever exists when the task timeout ends.
            error = None if proc.returncode in (0, 124) else "Task-local HybridClaw exited unsuccessfully"
            (spec.output_dir / "execution.json").write_text(json.dumps({
                "exit_code": proc.returncode, "timed_out": proc.returncode == 124,
                "elapsed_time": elapsed,
            }))
            return AgentExecution(elapsed_time=elapsed, error=error, agent_proc=proc)
        except Exception as exc:
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait()
            return AgentExecution(elapsed_time=time.perf_counter() - started,
                                  error=str(exc), agent_proc=proc)

    def prepare_grading_transcript(self, task_id):
        # Conversion happens after the task-local gateway and workers stop.
        docker("exec", task_id, "python3", "/opt/wildclawbench/evidence.py",
               RUNTIME + "/data/hybridclaw.db", TRANSCRIPT)
        return TRANSCRIPT

    def collect_usage(self, task_id, output_dir, elapsed_time):
        output_dir = Path(output_dir)
        evidence = output_dir / "hybridclaw-runtime"
        _copy_changed_workspace_outputs_from_container(task_id, output_dir / "workspace-changes")
        try:
            # Copy only the data subtree. Runtime credentials and encryption
            # keys live beside it and never leave the disposable container.
            docker("cp", task_id + ":" + RUNTIME + "/data/.", str(evidence))
            try:
                docker("cp", task_id + ":" + TRANSCRIPT, str(output_dir / "chat.jsonl"))
            except RuntimeError:
                pass  # Billing still matters when execution/transcript failed.
            logs = [evidence / "gateway" / name for name in
                    ("model-responses.log", "generation-ids.log")]
            text = "\n".join(log.read_text() for log in logs if log.exists())
            identifiers = generation_ids(text)
            records = []
            for identifier in identifiers:
                url = "https://openrouter.ai/api/v1/generation?" + urllib.parse.urlencode({"id": identifier})
                request = urllib.request.Request(url, headers={
                    "Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"],
                })
                # Adapter choice, 2026-10-30: billing metadata lagged the live
                # response. Retry metadata GETs only, never the agent task.
                for attempt in range(6):
                    try:
                        with urllib.request.urlopen(request, timeout=30) as response:
                            records.append(json.load(response)["data"])
                        break
                    except (OSError, ValueError, KeyError):
                        if attempt == 5:
                            raise RuntimeError("OpenRouter billing metadata unavailable") from None
                        time.sleep(min(2 ** attempt, 16))
            (output_dir / "openrouter-generations.json").write_text(json.dumps(records, indent=2))
            totals = summarize_generations(records)
        except (OSError, RuntimeError, ValueError):
            # Upstream expects numeric usage even on infrastructure failure.
            # The exporter must refuse this incomplete accounting record.
            totals = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
                      "cache_write_tokens": 0, "total_tokens": 0, "cost_usd": 0,
                      "request_count": 0, "accounting_complete": False,
                      "cost_source": "unavailable"}
        try:
            totals["provenance"] = json.loads((output_dir / "provenance.json").read_text())
        except (OSError, ValueError):
            totals["provenance"] = {}  # Export refuses missing or mixed revisions.
        totals["elapsed_time"] = round(elapsed_time, 2)
        return totals
