"""One resident local classifier. Setup alone downloads; serving uses offline weights.
The pipe accepts bounded choice questions, not executable code or remote model IDs.
Routing confidence is the selected option probability, not entropy.
"""
import hashlib
import json
import os
from pathlib import Path
import sys

# Engineering choice, 2026-09-29: multilingual covers German and English at 322M.
# Core ML's short ANE path is deferred because its 96-token budget is too small.
REPO = "aac6fef/laya-multilingual-mlx"
REVISION = "ba40c87fcb357f1643d04d71323af9cdc3b9e591"
WEIGHT_SHA256 = "7fc5834af4d8fdfb268d272a9d1a66e5819a0daac98241651c4c888cc43adff1"


def verify(model):
    with (model / "model.safetensors").open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != WEIGHT_SHA256:
            raise ValueError("Model integrity check failed")


def predict(agent, request):
    state = request["text"]
    questions = request["questions"]
    if not isinstance(state, str) or not 0 < len(state) <= 4000:
        raise ValueError("Invalid state")
    if not isinstance(questions, dict) or set(questions) != {"tier"}:
        raise ValueError("Invalid questions")
    q = questions["tier"]
    if q.get("type") != "choice" or not isinstance(q.get("criteria"), dict):
        raise ValueError("Invalid choice")
    # Pinned laya-mlx 0.2.0 caps each rendered option at 48 tokens and the
    # combined instruction/options at head_max_len. Refuse any truncation.
    def tokens(text):
        return len(agent.tok(text.replace(agent.tok.mask_token, " "))["input_ids"])
    option_lengths = [tokens(" " + label + ": " + description)
                      for label, description in q["criteria"].items()]
    head_tokens = tokens("choice question: " + q["instructions"]) + sum(n + 1 for n in option_lengths)
    if any(n > 48 for n in option_lengths) or head_tokens > agent.cfg["head_max_len"]:
        raise ValueError("Decision choices exceeded")
    if head_tokens + tokens(state) + 4 > agent.cfg["max_len"]:
        raise ValueError("Decision context exceeded")
    result = agent.predict(state, questions)
    answer = result["answers"]["tier"]
    # Upstream answer_confidence semantics (2026-09-29): gate on the selected
    # option probability, not 1 - normalized entropy from laya-mlx 0.2.0.
    answer["confidence"] = answer["probabilities"][answer["choice"]]
    return result


def main():
    mode, home = sys.argv[1:]
    model = Path(home) / "model"
    if mode == "setup":
        from huggingface_hub import snapshot_download
        snapshot_download(REPO, revision=REVISION, local_dir=model,
                          allow_patterns=["*.json", "*.safetensors", "encoder/*.json", "tokenizer/*"])
        verify(model)
        return
    if mode != "serve":
        raise ValueError("Unknown operation")
    os.environ["HF_HUB_OFFLINE"] = "1"
    import laya_mlx
    verify(model)
    agent = laya_mlx.load(str(model), dtype="float16")
    print(json.dumps({"ready": True}), flush=True)
    while line := sys.stdin.buffer.readline(65537):
        if len(line) > 65536:
            raise ValueError("Request too large")
        try:
            result = predict(agent, json.loads(line))
            print(json.dumps({"result": result}), flush=True)
        except Exception:
            print(json.dumps({"error": "decision-failed"}), flush=True)


if __name__ == "__main__":
    main()
