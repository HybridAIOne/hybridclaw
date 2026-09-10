"""Token accounting tests require no model, credentials, or GPU."""
import unittest
from types import SimpleNamespace
from runtime_metrics import RuntimeMetrics


class RuntimeMetricsTests(unittest.TestCase):
    def test_counts_all_generated_states_lazily_without_retaining_payloads(self):
        metrics = RuntimeMetrics()
        responses = [SimpleNamespace(state=state, text="private-payload", token=123)
                     for state in ["reasoning", "normal", "tool_call"]]
        def source():
            yield from responses
        stream = metrics.observe(source())
        self.assertEqual(metrics.snapshot()["generatedTokens"], 0)
        self.assertIs(next(stream), responses[0])
        self.assertEqual(metrics.snapshot()["generatedTokens"], 1)
        self.assertEqual(list(stream), responses[1:])
        snapshot = metrics.snapshot()
        self.assertEqual(snapshot["generatedTokens"], 3)
        self.assertEqual(set(snapshot), {"instanceId", "generatedTokens"})
        self.assertRegex(snapshot["instanceId"], r"^[a-f0-9]{32}$")
        self.assertNotIn("private-payload", str(snapshot))

    def test_cancel_and_failure_close_the_underlying_generator(self):
        for fail in [False, True]:
            metrics = RuntimeMetrics()
            closed = []
            def source():
                try:
                    yield object()
                    if fail:
                        raise ValueError("test failure")
                    yield object()
                finally:
                    closed.append(True)
            stream = metrics.observe(source())
            next(stream)
            if fail:
                with self.assertRaises(ValueError):
                    next(stream)
            else:
                stream.close()
            self.assertEqual(closed, [True])
            self.assertEqual(metrics.snapshot()["generatedTokens"], 1)

    def test_counts_across_requests_and_resets_identity_on_restart(self):
        first = RuntimeMetrics()
        def source():
            yield object()
        list(first.observe(source()))
        list(first.observe(source()))
        self.assertEqual(first.snapshot()["generatedTokens"], 2)
        second = RuntimeMetrics()
        self.assertEqual(second.snapshot()["generatedTokens"], 0)
        self.assertNotEqual(first.snapshot()["instanceId"], second.snapshot()["instanceId"])


if __name__ == "__main__": unittest.main()
