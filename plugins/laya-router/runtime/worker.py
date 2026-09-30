"""One resident local classifier. Setup alone downloads; serving uses offline weights.
The pipe accepts bounded choice questions, not executable code or remote model IDs.
The frozen multilingual encoder feeds a specialized four-band routing readout.
Separate temperature calibration supplies confidence; middle bands can be grouped.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import sys

# Evaluation choice, 2026-09-29: a multilingual encoder with a supervised
# routing readout improved accuracy and coverage on 200 fresh bilingual cases.
# Core ML's short ANE path is deferred because its 96-token budget is too small.
CALIBRATION = json.loads(Path(__file__).with_name("routing-calibration.json").read_text())


def verify(model):
    with (model / "model.safetensors").open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != CALIBRATION["weight_sha256"]:
            raise ValueError("Model integrity check failed")
    for name, digest in CALIBRATION["model_files_sha256"].items():
        if hashlib.sha256((model / name).read_bytes()).hexdigest() != digest:
            raise ValueError("Model configuration integrity check failed")


def readout(features):
    if len(features) != len(CALIBRATION["matrix"]) or not all(math.isfinite(v) for v in features):
        raise ValueError("Invalid encoder features")
    norm = math.sqrt(sum(v*v for v in features))
    if not math.isfinite(norm) or norm <= 0:
        raise ValueError("Invalid encoder norm")
    logits = [(sum(v/norm*row[j] for v, row in zip(features, CALIBRATION["matrix"])) + CALIBRATION["bias"][j])/CALIBRATION["temperature"] for j in range(4)]
    if not all(math.isfinite(v) for v in logits):
        raise ValueError("Invalid routing logits")
    weights = [math.exp(v-max(logits)) for v in logits]
    return [v/sum(weights) for v in weights]


def encode(agent, state, question):
    import mlx.core as mx
    from laya_mlx.common import build_prefix
    items, internal = agent.prepare(state, {"tier": question})
    item = items[0]
    prefix, _ = build_prefix(agent.tok, internal[0], agent.cfg["head_max_len"])
    state_ids = agent.tok(json.dumps(state, ensure_ascii=False).replace(agent.tok.mask_token, " "),
                          add_special_tokens=False)["input_ids"]
    if len(item["ids"]) != len(prefix)+len(state_ids)+1 or len(item["markers"]) != 4:
        raise ValueError("Decision context truncated")
    with mx.stream(agent.device):
        ids = mx.array([item["ids"]])
        hidden = agent.model.encoder(ids, mx.ones(ids.shape, dtype=mx.bool_))
        features = hidden[0, len(prefix):-1].astype(mx.float32).mean(axis=0)
        mx.eval(features)
    return features.tolist(), len(item["ids"])


def predict(agent, request):
    text = request["text"]
    questions = request["questions"]
    if not isinstance(text, str) or not 0 < len(text) <= 4000:
        raise ValueError("Invalid state")
    if not isinstance(questions, dict) or set(questions) != {"tier"}:
        raise ValueError("Invalid questions")
    q = questions["tier"]
    if q.get("type") != "choice" or not isinstance(q.get("criteria"), dict):
        raise ValueError("Invalid choice")
    labels = list(q["criteria"])
    if len(labels) not in (3,4):
        raise ValueError("Laya routing requires three or four tiers")
    rubric = json.dumps(list(q["criteria"].values()), ensure_ascii=False, separators=(",", ":"))
    if hashlib.sha256(rubric.encode()).hexdigest() != CALIBRATION["gateway_rubric_sha256"][str(len(labels))]:
        raise ValueError("Routing rubric differs from calibrated task")
    state = {"task": text}
    q = CALIBRATION["question"]
    # Pinned laya-mlx 0.2.0 caps each rendered option at 48 tokens and the
    # combined instruction/options at head_max_len. Refuse any truncation.
    def tokens(text):
        return len(agent.tok(text.replace(agent.tok.mask_token, " "))["input_ids"])
    option_lengths = [tokens(" " + label + ": " + description)
                      for label, description in q["criteria"].items()]
    head_tokens = tokens("choice question: " + q["instructions"]) + sum(n + 1 for n in option_lengths)
    if any(n > 48 for n in option_lengths) or head_tokens > agent.cfg["head_max_len"]:
        raise ValueError("Decision choices exceeded")
    if head_tokens + tokens(json.dumps(state, ensure_ascii=False)) + 4 > agent.cfg["max_len"]:
        raise ValueError("Decision context exceeded")
    features, input_tokens = encode(agent, state, q)
    values = readout(features)
    if len(labels) == 3:
        values = [values[0], values[1]+values[2], values[3]]
    return {"model": "laya-routing-head", "answers": {"tier": {
        "type": "choice", "probabilities": dict(zip(labels, values)),
        "choice": labels[max(range(len(values)), key=values.__getitem__)], "confidence": max(values)}},
        "usage": {"input_tokens": input_tokens, "output_tokens": 0}}


def main():
    mode, home = sys.argv[1:]
    model = Path(home) / "model"
    if mode == "setup":
        from huggingface_hub import snapshot_download
        snapshot_download(CALIBRATION["repo"], revision=CALIBRATION["revision"], local_dir=model,
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
