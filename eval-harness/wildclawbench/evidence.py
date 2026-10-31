"""Convert native stored exchanges without discarding tool arguments or results."""

import json
import math
from pathlib import Path
import sqlite3


def convert_message(message):
    role = message["role"]
    if role == "tool":
        return {"type": "toolResult", "toolResult": {
            "content": message.get("content", ""),
            "tool_call_id": message.get("tool_call_id", ""),
        }}
    content = message.get("content", "")
    if message.get("tool_calls"):
        blocks = [{"type": "text", "text": content}] if content else []
        for call in message["tool_calls"]:
            function = call["function"]
            arguments = function["arguments"]
            try:
                arguments = json.loads(arguments)
            except (ValueError, TypeError):
                pass
            blocks.append({"type": "tool_use", "id": call["id"],
                           "name": function["name"], "input": arguments})
        content = blocks
    return {"type": "message", "message": {"role": role, "content": content}}


def convert_database(database, output):
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
        rows = db.execute(
            "SELECT role, content, tool_history_json FROM messages ORDER BY id"
        ).fetchall()
    messages = []
    for role, content, history in rows:
        if history:
            messages.extend(convert_message(message) for message in json.loads(history))
        messages.append(convert_message({"role": role, "content": content}))
    if not messages:
        raise RuntimeError("Native transcript is empty")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("".join(json.dumps(m, ensure_ascii=False) + "\n" for m in messages))


def generation_ids(text):
    ids = set()
    for line in text.splitlines():
        if line.startswith("data: "):
            raw = line[6:]
        elif line.startswith("[model-response-debug] "):
            raw = line[len("[model-response-debug] "):]
        else:
            continue
        try:
            payload = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(payload, dict):
            continue
        response = payload.get("response", payload)
        if not isinstance(response, dict):
            continue
        identifier = response.get("id", "")
        if isinstance(identifier, str) and identifier.startswith("gen-"):
            ids.add(identifier)
    return sorted(ids)


def summarize_generations(records):
    if not records:
        raise ValueError("No OpenRouter generation records")
    totals = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
              "cache_write_tokens": 0, "total_tokens": 0, "cost_usd": 0.0,
              "request_count": len(records)}
    for data in records:
        if not isinstance(data, dict):
            raise ValueError("Invalid generation metadata")
        # Missing billing is unknown, never a fabricated zero-dollar request.
        cost = data.get("total_cost")
        if not isinstance(cost, (float, int)) or not math.isfinite(cost) or cost < 0:
            raise ValueError("Generation has no valid total_cost")
        totals["cost_usd"] += cost
        totals["input_tokens"] += data.get("native_tokens_prompt") or data.get("tokens_prompt") or 0
        totals["output_tokens"] += data.get("native_tokens_completion") or data.get("tokens_completion") or 0
        totals["cache_read_tokens"] += data.get("native_tokens_cached") or 0
    totals["total_tokens"] = totals["input_tokens"] + totals["output_tokens"]
    totals["accounting_complete"] = True
    totals["cost_source"] = "openrouter-generation"
    return totals


if __name__ == "__main__":
    import sys
    convert_database(sys.argv[1], sys.argv[2])
