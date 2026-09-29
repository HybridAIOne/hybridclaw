import unittest
from types import SimpleNamespace
from worker import predict

class FakeTokenizer:
    mask_token = "[MASK]"
    def __call__(self, text):
        return {"input_ids": list(text)}

class WorkerBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.agent = SimpleNamespace(tok=FakeTokenizer(), cfg={"max_len": 1024, "head_max_len": 192}, predict=lambda text, questions: self.calls.append(text) or {"ok": True})
        self.request = {"text": "Hello", "questions": {"tier": {"type": "choice", "instructions": "Choose", "criteria": {"a": "simple", "b": "hard"}}}}
    def test_valid(self):
        self.assertEqual(predict(self.agent, self.request), {"ok": True})
    def test_oversize_state_is_not_silently_truncated(self):
        self.request["text"] = "x" * 1024
        with self.assertRaises(ValueError): predict(self.agent, self.request)
        self.assertEqual(self.calls, [])
    def test_oversize_choices_are_not_silently_truncated(self):
        self.request["questions"]["tier"]["criteria"]["c"] = "x" * 192
        with self.assertRaises(ValueError): predict(self.agent, self.request)
        self.assertEqual(self.calls, [])
    def test_unknown_question_rejected(self):
        self.request["questions"]["other"] = {}
        with self.assertRaises(ValueError): predict(self.agent, self.request)

if __name__ == '__main__': unittest.main()
