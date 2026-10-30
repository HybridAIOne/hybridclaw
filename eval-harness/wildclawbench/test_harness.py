"""Offline contract tests; these fixtures are never benchmark measurements."""

import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from evidence import convert_database, generation_ids, summarize_generations

spec = importlib.util.spec_from_file_location("wcb_export", Path(__file__).with_name("export.py"))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


def complete_summary():
    rows = []
    for category in range(1, 7):
        for task in range(1, 11):
            rows.append({
                "task_id": f"{category:02}_task_{task}_test-model_20260101_0000_abc123",
                "scores": {"overall_score": 0.5}, "error": None,
                "usage": {"accounting_complete": True, "cost_usd": 0.2, "elapsed_time": 120,
                          "provenance": {"hybridclaw_commit": "a" * 40,
                                         "hybridclaw_version": "0.0.0", "image_id": "sha256:" + "b" * 64}},
            })
    return {"task_count": 60, "global_avg": 0.5, "results": rows}


class EvidenceTests(unittest.TestCase):
    def test_database_preserves_tool_pairing_arguments_and_multiline_results(self):
        temporary = tempfile.TemporaryDirectory(prefix="wcb-contract-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        history = [
            {"role": "assistant", "content": "Inspecting files", "tool_calls": [{
                "id": "call_a", "function": {"name": "bash", "arguments": '{"command":"ls"}'},
            }]},
            {"role": "tool", "tool_call_id": "call_a", "content": "first\nsecond\n"},
        ]
        with sqlite3.connect(root / "native.db") as db:
            db.execute("CREATE TABLE messages(id INTEGER, role TEXT, content TEXT, tool_history_json TEXT)")
            db.execute("INSERT INTO messages VALUES(1,'user','Inspect this folder',NULL)")
            db.execute("INSERT INTO messages VALUES(2,'assistant','Done',?)", (json.dumps(history),))
        output = root / "sessions" / "chat.jsonl"
        convert_database(root / "native.db", output)
        rows = [json.loads(line) for line in output.read_text().splitlines()]
        self.assertEqual([r.get("message", {}).get("role", r["type"]) for r in rows],
                         ["user", "assistant", "toolResult", "assistant"])
        self.assertEqual(rows[1]["message"]["content"][1]["input"], {"command": "ls"})
        self.assertEqual(rows[2]["toolResult"], {"tool_call_id": "call_a", "content": "first\nsecond\n"})

    def test_generation_ids_deduplicate_stream_and_final_response(self):
        text = '\n'.join([
            'data: {"id":"gen-a","choices":[]}',
            'data: [DONE]',
            '[model-response-debug] {"response":{"id":"gen-a"}}',
            '[model-response-debug] {"response":{"id":"gen-b"}}',
            'data: {"id":"other-id"}',
            'data: null',
            '[model-response-debug] {"response":null}',
        ])
        self.assertEqual(generation_ids(text), ["gen-a", "gen-b"])

    def test_billing_uses_provider_total_cost_and_native_tokens(self):
        usage = summarize_generations([{"total_cost": 0.3, "native_tokens_prompt": 100,
                                        "native_tokens_completion": 20, "native_tokens_cached": 40}])
        self.assertEqual(usage["total_tokens"], 120)
        self.assertEqual(usage["cache_read_tokens"], 40)
        self.assertEqual(usage["cost_usd"], 0.3)

    def test_missing_billing_is_unknown(self):
        for records in ([], [None], [{}], [{"total_cost": None}], [{"total_cost": -1}],
                        [{"total_cost": float("nan")}]):
            with self.subTest(records=records), self.assertRaises(ValueError):
                summarize_generations(records)


class ExportTests(unittest.TestCase):
    def export(self, summary):
        return exporter.export_run(summary, next(iter(exporter.MODELS)),
                                   {f"{n:02}": f"category_{n}" for n in range(1, 7)},
                                   {f"{n:02}_task_{t}" for n in range(1, 7) for t in range(1, 11)},
                                   "2026-10-30")

    def test_complete_run_exports_percentage_and_means(self):
        result = self.export(complete_summary())
        self.assertEqual(result["source_variant"], "patched")
        self.assertEqual(result["hybridclaw_commit"], "a" * 40)
        self.assertEqual(result["score"], 50)
        self.assertAlmostEqual(result["usd_per_task"], 0.2)
        self.assertEqual(result["minutes_per_task"], 2)
        self.assertEqual(len(result["per_category"]), 6)

    def test_partial_duplicate_or_unbilled_runs_are_rejected(self):
        for mutation in (
            lambda s: s["results"].pop(),
            lambda s: s["results"].__setitem__(1, s["results"][0]),
            lambda s: s["results"][0]["usage"].__setitem__("accounting_complete", False),
        ):
            summary = complete_summary()
            mutation(summary)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.export(summary)

    def test_missing_or_mixed_source_provenance_is_rejected(self):
        for change in ({}, {"hybridclaw_commit": "c" * 40,
                           "hybridclaw_version": "0.0.0", "image_id": "sha256:" + "b" * 64}):
            summary = complete_summary()
            summary["results"][0]["usage"]["provenance"] = change
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.export(summary)

    def test_missing_score_is_zero_with_full_denominator(self):
        summary = complete_summary()
        summary["results"][0]["scores"] = {}
        summary["global_avg"] = 29.5 / 60
        result = self.export(summary)
        self.assertEqual(result["failed_infra"], 1)
        self.assertEqual(result["score"], round(29.5 / 60 * 100, 4))

    def test_judge_failure_is_infrastructure_even_with_numeric_zero(self):
        summary = complete_summary()
        summary["results"][0]["scores"] = {"overall_score": 0, "judge_error": "test error"}
        summary["global_avg"] = 29.5 / 60
        self.assertEqual(self.export(summary)["failed_infra"], 1)


if __name__ == "__main__":
    unittest.main()
