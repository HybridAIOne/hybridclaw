"""One resident local classifier. Setup alone downloads; serving uses offline weights.
The pipe accepts bounded choice questions, not executable code or remote model IDs.
The pinned four-band calibration is grouped into three or four configured tiers.
Confidence estimates selected-tier correctness; class probabilities stay distinct.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import sys

# Evaluation choice, 2026-09-29: typed-decisions with activity criteria and a
# frozen affine map met the JEV precision target on 200 fresh rubric cases.
# Core ML's short ANE path is deferred because its 96-token budget is too small.
CALIBRATION = json.loads(Path(__file__).with_name("routing-calibration.json").read_text())


def verify(model):
    with (model / "model.safetensors").open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != CALIBRATION["weight_sha256"]:
            raise ValueError("Model integrity check failed")


def calibrated_probabilities(probabilities):
    values = [probabilities[label] for label in CALIBRATION["criteria"]]
    if not all(math.isfinite(p) and 0 <= p <= 1 for p in values) or abs(sum(values)-1) > .001:
        raise ValueError("Invalid probabilities")
    logs = [math.log(max(1e-8, p)) for p in values]
    mean = sum(logs)/len(logs)
    logits = [sum((logs[i]-mean)*CALIBRATION["matrix"][i][j] for i in range(4)) + CALIBRATION["bias"][j] for j in range(4)]
    weights = [math.exp(v-max(logits)) for v in logits]
    return [v/sum(weights) for v in weights]


def correctness(p, count):
    coefficients = CALIBRATION["correctness"][str(count)]
    p = min(1-1e-6, max(1e-6, p))
    z = coefficients["a"]*math.log(p/(1-p))+coefficients["b"]
    return 1/(1+math.exp(-z)) if z >= 0 else math.exp(z)/(1+math.exp(z))


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
    q = {"type": "choice", "instructions": CALIBRATION["instructions"], "criteria": CALIBRATION["criteria"]}
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
    result = agent.predict(state, {"tier": q})
    answer = result["answers"]["tier"]
    values = calibrated_probabilities(answer["probabilities"])
    if len(labels) == 3:
        values = [values[0], values[1]+values[2], values[3]]
    answer["probabilities"] = dict(zip(labels, values))
    answer["choice"] = labels[max(range(len(values)), key=values.__getitem__)]
    answer["confidence"] = correctness(max(values), len(labels))
    return result


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
