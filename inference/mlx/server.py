"""Authenticated, single-worker MLX service; all inference uses one pinned model.

The upstream generator supplies chat/tool streaming. This boundary owns auth,
resource admission, task cache isolation and lifecycle, never agent tools.
"""

import argparse
import hashlib
import hmac
import io
import json
import logging
import os
import re
import select
import signal
import socket
import sys
import threading
import time
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

from model_store import validate_manifest
from trusted_architectures import SPARK_ARTIFACT, register_packaged_model

COMPONENT_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
MAX_BODY = 2 * 1024 * 1024
ALLOWED_KEYS = {"model", "messages", "tools", "tool_choice", "stream", "stream_options", "max_tokens", "max_completion_tokens", "temperature", "top_p", "seed", "stop", "parallel_tool_calls"}


class ContextBudgetError(ValueError):
    """Only numeric admission diagnostics may cross the local HTTP boundary."""

    def __init__(self, prompt_tokens, output_tokens, context_window, tool_count):
        super().__init__(
            f"Local context limit exceeded: {prompt_tokens} prompt tokens + "
            f"{output_tokens} output tokens > {context_window} tokens "
            f"({tool_count} tools). Reduce instructions or enabled tools, "
            "or select a model with a larger context window."
        )


def validate_context_budget(prompt_tokens, output_tokens, context_window, tool_count):
    if prompt_tokens + output_tokens > context_window:
        raise ContextBudgetError(prompt_tokens, output_tokens, context_window, tool_count)


def preparation_error(error):
    if isinstance(error, ContextBudgetError):
        return error
    # Library messages can include prompt content, schema values or file paths.
    # Keep the known failure category, never their text or arbitrary class names.
    if isinstance(error, MemoryError):
        return ValueError("Local request preparation ran out of memory. Close other apps and retry.")
    return ValueError(
        "Local model could not prepare the messages and tool definitions. "
        "Check the local runtime and its message and tool support."
    )


class GeneratedToolCallError(ValueError):
    """Fixed boundary diagnostics, never raw model output or library errors."""


def validate_generated_tool_calls(response, allowed):
    for choice in response.get("choices", []):
        for call in choice.get("message", choice.get("delta", {})).get("tool_calls", []):
            function = call.get("function", {})
            if function.get("name") not in allowed:
                raise GeneratedToolCallError(
                    "Local model tried to call a tool that was not exposed. "
                    "Use tool_catalog for additional tools, or add the needed tool to the starred set."
                )
            try:
                arguments = json.loads(function.get("arguments", ""))
            except (ValueError, TypeError):
                arguments = None
            if not isinstance(arguments, dict):
                raise GeneratedToolCallError(
                    "Local model generated invalid tool arguments. Retry the request."
                )


def generation_error(error):
    if isinstance(error, GeneratedToolCallError):
        return str(error)
    if isinstance(error, MemoryError):
        return "Local inference ran out of memory. Close other apps and retry."
    return "Local inference failed; check the local model runtime."


def validate_body(body, model, max_tokens):
    if not isinstance(body, dict) or set(body) - ALLOWED_KEYS:
        raise ValueError("Unsupported request fields")
    if body.get("model") != model:
        raise ValueError("Only the installed model is available")
    count = body.get("max_completion_tokens", body.get("max_tokens", max_tokens))
    if type(count) is not int or not 1 <= count <= max_tokens:
        raise ValueError("Output budget exceeds installation limit")
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("Messages are required")
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant", "tool"}:
            raise ValueError("Invalid message")
        content = message.get("content")
        if isinstance(content, list):
            if any(not isinstance(p, dict) or p.get("type") != "text" or not isinstance(p.get("text"), str) for p in content):
                raise ValueError("This installation supports text only")
        elif content is not None and not isinstance(content, str):
            raise ValueError("Invalid message content")
    tools = body.get("tools", [])
    if not isinstance(tools, list) or len(tools) > 128:
        raise ValueError("Invalid tools")
    names = set()
    for tool in tools:
        function = tool.get("function", {}) if isinstance(tool, dict) else {}
        name = function.get("name", "")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", name) or name in names or tool.get("type") != "function" or not isinstance(function.get("parameters", {}), dict):
            raise ValueError("Invalid tool definition")
        names.add(name)
    if body.get("tool_choice", "auto") != "auto":
        raise ValueError("This installation supports automatic tool selection")
    return body


def validate_profile(profile):
    for key in ["port", "contextWindow", "maxTokens", "memoryLimitBytes", "cacheBytes"]:
        if type(profile.get(key)) is not int or profile[key] <= 0:
            raise ValueError("Invalid installation resource budget")
    context_limit = 40960 if (profile.get("repo"), profile.get("revision")) == SPARK_ARTIFACT else 8192
    if not (1024 <= profile["port"] <= 65535 and 2048 <= profile["contextWindow"] <= context_limit and
            profile["maxTokens"] <= profile["contextWindow"] and profile["cacheBytes"] <= profile["memoryLimitBytes"]):
        raise ValueError("Invalid installation limits")


def serve(home):
    # Set before importing libraries; serving cannot contact the model registry.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    logging.disable(logging.CRITICAL)
    parent_pid = os.getppid()
    def watch_owner():
        while True:
            time.sleep(1)
            if os.getppid() != parent_pid:
                os._exit(0)
    threading.Thread(target=watch_owner, daemon=True).start()
    import mlx.core as mx
    from mlx_lm import stream_generate
    from mlx_lm.models.cache import LRUPromptCache
    from mlx_lm.server import APIHandler, ModelProvider, ResponseGenerator

    profile = json.loads((home / "installation.json").read_text())
    manifest = json.loads((home / "manifest.json").read_text())
    model_path = home / "models" / manifest["revision"]
    validate_manifest(manifest, model_path)
    model_config = json.loads((model_path / "config.json").read_text())
    register_packaged_model(model_config)
    # 2026-09-10, Codex qualification: Spark fabricated a tool result with
    # thinking disabled. Retain its publisher default; other ports stay bounded.
    enable_thinking = model_config.get("model_type") == "spark2_5"
    if profile["revision"] != manifest["revision"] or profile["repo"] != manifest["repo"]:
        raise ValueError("Installation and manifest disagree")
    validate_profile(profile)
    if profile["memoryLimitBytes"] > mx.device_info()["max_recommended_working_set_size"]:
        raise ValueError("Installation exceeds this GPU's recommended memory budget")
    if (home / "token").stat().st_mode & 0o077:
        raise ValueError("Service credential must be private to its owner")
    token = (home / "token").read_text().strip()
    if len(token) < 32:
        raise ValueError("Missing service credential")
    mx.set_memory_limit(profile["memoryLimitBytes"])
    # Retain the process wired budget across generator recreation and idle time.
    # MLX-LM's generation contexts restore the prior value when they close.
    mx.set_wired_limit(profile["memoryLimitBytes"])
    mx.set_cache_limit(256 * 1024 * 1024)
    args = argparse.Namespace(model=str(model_path), adapter_path=None, draft_model=None,
        trust_remote_code=False, chat_template="", use_default_chat_template=False,
        chat_template_args={"enable_thinking": enable_thinking}, pipeline=False, num_draft_tokens=0,
        allowed_origins=[], max_tokens=profile["maxTokens"], temp=0.2, top_p=0.95, top_k=20, min_p=0,
        decode_concurrency=1, prompt_concurrency=1, prefill_step_size=256,
        prompt_cache_size=2, prompt_cache_bytes=profile["cacheBytes"])

    class PinnedProvider(ModelProvider):
        scope = "startup"

        def load(self, model_path, adapter_path=None, draft_model_path=None):
            if self.model is None:
                super().load(str(home / "models" / manifest["revision"]))
            # Switch namespaces only on the generator thread after its old
            # batch drains; an HTTP handler must not relabel in-flight caches.
            if str(model_path).startswith("hybridclaw-task-"):
                next_scope = str(model_path).removeprefix("hybridclaw-task-")
                if self.scope != next_scope:
                    generator._state_machine_cache.clear()
                self.scope = next_scope
            self.model_key = (manifest["revision"], self.scope)
            return self.model, self.tokenizer

    provider = PinnedProvider(args)
    provider.load_default()
    # Warm resident weights and first-token kernels before publishing readiness.
    warm_prompt = provider.tokenizer.apply_chat_template(
        [{"role": "user", "content": "Say hello."}], tokenize=True,
        add_generation_prompt=True, enable_thinking=enable_thinking,
    )
    for _ in stream_generate(provider.model, provider.tokenizer, warm_prompt,
                             max_tokens=1, prefill_step_size=256):
        pass
    mx.synchronize()
    idle = threading.Event()
    idle.set()

    class Generator(ResponseGenerator):
        context = None
        response_queue = None

        def _next_request(self, timeout=None):
            request = super()._next_request(timeout)
            if request is not None:
                self.response_queue = request[0]
            return request

        def cancel_context(self):
            if self.context:
                self.context.stop()
                # Upstream batch cancellation removes the GPU request without
                # ending its response queue. Wake non-streaming HTTP handlers.
                if self.response_queue is not None:
                    self.response_queue.put(None)

        def _serve_single(self, *args, **kwargs):
            idle.clear()
            try:
                return super()._serve_single(*args, **kwargs)
            finally:
                idle.set()

        def _tokenize(self, tokenizer, request, arguments):
            result = super()._tokenize(tokenizer, request, arguments)
            validate_context_budget(
                len(result[0]), arguments.max_tokens, profile["contextWindow"],
                len(request.tools or []),
            )
            return result

        def generate(self, *args, **kwargs):
            try:
                ctx, stream = super().generate(*args, **kwargs)
            except Exception as error:
                raise preparation_error(error) from None
            self.context = ctx
            return ctx, stream

    generator = Generator(provider, LRUPromptCache(2, profile["cacheBytes"]))
    admission = threading.Lock()

    class Handler(APIHandler):
        def log_message(self, *_args):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def reply(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            if self.headers.get("Origin") or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.reply(401, {"error": "Unauthorized"})
                return False
            return True

        def validate_model_parameters(self):
            super().validate_model_parameters()
            # The generator keys batch state by model description. Include the
            # task namespace there too, so recurrent caches never cross tasks.
            self.requested_model = "hybridclaw-task-" + self.task_scope

        def completion_usage_response(self, *args, **kwargs):
            response = super().completion_usage_response(*args, **kwargs)
            response["model"] = profile["model"]
            return response

        def generate_response(self, *args, **kwargs):
            response = super().generate_response(*args, **kwargs)
            response["model"] = profile["model"]
            allowed = {t["function"]["name"] for t in self.body.get("tools", [])}
            validate_generated_tool_calls(response, allowed)
            return response

        def _set_completion_headers(self, status_code=200):
            super()._set_completion_headers(400 if status_code == 404 else status_code)

        def do_OPTIONS(self):
            self.reply(405, {"error": "Browser access is disabled"})

        def do_GET(self):
            if not self.authorized():
                return
            if self.path == "/health":
                self.reply(200 if generator._generation_thread.is_alive() else 503, {
                    "status": "ready" if generator._generation_thread.is_alive() else "failed", "model": profile["model"],
                    "revision": manifest["revision"], "engine": "mlx-lm/0.31.3", "componentSha256": COMPONENT_SHA256, "zone": "local",
                    "peakMemoryBytes": mx.get_peak_memory(), "activeMemoryBytes": mx.get_active_memory(),
                })
            elif self.path == "/v1/models":
                self.reply(200, {"object": "list", "data": [{"id": profile["model"], "object": "model", "context_length": profile["contextWindow"], "max_tokens": profile["maxTokens"], "owned_by": "local", "vision": False}]})
            else:
                self.reply(404, {"error": "Unknown route"})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path == "/control/stop":
                self.reply(200, {"status": "stopping"})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if self.path != "/v1/chat/completions":
                self.reply(404, {"error": "Unknown route"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.headers.get("Transfer-Encoding") or not 0 < length <= MAX_BODY:
                    raise ValueError("Invalid request length")
                raw = self.rfile.read(length)
                body = validate_body(json.loads(raw), profile["model"], profile["maxTokens"])
            except (ValueError, TypeError, TimeoutError):
                self.reply(400, {"error": "Invalid request or budget; check the installed model limits"})
                return
            if not admission.acquire(blocking=False):
                self.reply(429, {"error": "Local model is busy; retry after the active request"})
                return
            done = threading.Event()
            try:
                scope = self.headers.get("X-HybridClaw-Task") or os.urandom(16).hex()
                self.task_scope = hashlib.sha256(scope.encode()).hexdigest()
                generator.context = None
                generator.response_queue = None

                def watch_disconnect():
                    while not done.wait(0.05):
                        try:
                            readable, _, _ = select.select([self.connection], [], [], 0)
                            if readable and not self.connection.recv(1, socket.MSG_PEEK):
                                if generator.context:
                                    generator.cancel_context()
                                    return
                        except OSError:
                            return

                threading.Thread(target=watch_disconnect, daemon=True).start()
                self.rfile = io.BytesIO(json.dumps(body).encode())
                self.headers.replace_header("Content-Length", str(len(self.rfile.getvalue())))
                super().do_POST()
            except (BrokenPipeError, ConnectionError, TimeoutError):
                pass
            except Exception as error:
                # Only fixed categories cross the boundary, never library/model payloads.
                message = generation_error(error)
                if not body.get("stream"):
                    self._headers_buffer = []
                    self.reply(400, {"error": message})
                else:
                    payload = json.dumps({"error": {"message": message}})
                    self.wfile.write(f"data: {payload}\n\n".encode())
                    self.wfile.flush()
                self.close_connection = True
            finally:
                done.set()
                if generator.context:
                    generator.context.stop()
                if not idle.wait(30):
                    os._exit(1)  # A wedged GPU worker must not receive another request.
                admission.release()

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, *_args):
            pass  # No payload-bearing library tracebacks.

    server = Server(("127.0.0.1", profile["port"]), partial(Handler, generator))

    def stop(*_args):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(json.dumps({"event": "ready", "model": profile["model"], "port": profile["port"]}), flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        generator.cancel_context()
        server.server_close()
        generator.stop_and_join()


if __name__ == "__main__":
    try:
        serve(Path(sys.argv[1]))
    except Exception:
        print("MLX startup failed; verify the installation and available memory.", file=sys.stderr)
        sys.exit(1)
