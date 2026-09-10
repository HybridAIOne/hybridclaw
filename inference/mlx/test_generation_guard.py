"""Long reasoning, loop cancellation and isolation checks without a GPU."""
import unittest
import random
from types import SimpleNamespace
from unittest.mock import Mock
from generation_guard import ReasoningLoopError, guard_reasoning_stream
from server import generation_error


def responses(tokens, state="reasoning"):
    return (SimpleNamespace(token=token, state=state) for token in tokens)


class GenerationGuardTests(unittest.TestCase):
    def test_long_productive_reasoning_is_not_truncated(self):
        context = Mock()
        result = list(guard_reasoning_stream(context, responses(range(18427))))
        self.assertEqual(len(result), 18427)
        context.stop.assert_called_once()

    def test_sustained_exact_loops_cancel_native_generation(self):
        for period in [1, 7, 32, 64, 128, 256]:
            with self.subTest(period=period):
                context = Mock()
                stream = guard_reasoning_stream(context, responses(list(range(period)) * 2048))
                emitted = 0
                with self.assertRaises(ReasoningLoopError) as caught:
                    for _ in stream:
                        emitted += 1
                self.assertLess(emitted, 1024)
                context.stop.assert_called_once()
                self.assertIn("reasoning repeated in a loop", generation_error(caught.exception))

    def test_short_recaps_and_repeated_scaffolding_with_progress_are_allowed(self):
        tokens = []
        for step in range(128):
            tokens.extend(list(range(64)) + [1000 + step])
        self.assertEqual(len(list(guard_reasoning_stream(Mock(), responses(tokens)))), len(tokens))
        recap = list(range(128)) * 3
        self.assertEqual(len(list(guard_reasoning_stream(Mock(), responses(recap)))), len(recap))

    def test_code_tool_arguments_and_visible_repetition_are_not_reasoning_loops(self):
        for state in ["normal", "tool"]:
            stream = responses([1] * 4096, state)
            self.assertEqual(len(list(guard_reasoning_stream(Mock(), stream))), 4096)

    def test_state_transitions_and_separate_requests_reset_loop_history(self):
        short = list(responses(list(range(64)) * 3))
        stream = short + list(responses([1], "normal")) + short
        self.assertEqual(len(list(guard_reasoning_stream(Mock(), iter(stream)))), len(stream))
        for _ in range(2):
            self.assertEqual(len(list(guard_reasoning_stream(Mock(), iter(short)))), len(short))

    def test_linear_scan_matches_the_original_periodicity_rule(self):
        rng = random.Random(4)
        fixtures = [[rng.randrange(11) for _ in range(4096)]]
        for period in [1, 7, 63, 128, 191, 256]:
            base = [rng.randrange(100) for _ in range(period)]
            fixtures.append([999] * 33 + base * 12)
            fixtures.append(sum((base + [1000 + i] for i in range(12)), []))
        for tokens in fixtures:
            expected = len(tokens)
            for end in range(256, len(tokens) + 1, 16):
                suffix = tokens[max(0, end - 1024):end]
                if any(all(suffix[i] == suffix[i + period]
                           for i in range(len(suffix) - max(256, period * 4), len(suffix) - period))
                       for period in range(1, min(256, len(suffix) // 4) + 1)):
                    expected = end - 1
                    break
            emitted = 0
            try:
                for _ in guard_reasoning_stream(Mock(), responses(tokens)):
                    emitted += 1
            except ReasoningLoopError:
                pass
            self.assertEqual(emitted, expected)

    def test_closing_or_failing_a_stream_cancels_the_native_context(self):
        context = Mock()
        stream = guard_reasoning_stream(context, responses(range(4096)))
        next(stream)
        stream.close()
        context.stop.assert_called_once()
        def failed():
            yield SimpleNamespace(token=1, state="reasoning")
            raise RuntimeError("private library details")
        context = Mock()
        with self.assertRaises(RuntimeError) as caught:
            list(guard_reasoning_stream(context, failed()))
        context.stop.assert_called_once()
        self.assertNotIn("private", generation_error(caught.exception))


if __name__ == "__main__":
    unittest.main()
