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
        self.agent = SimpleNamespace(tok=FakeTokenizer(), cfg={"max_len": 1024, "head_max_len": 192}, predict=lambda text, questions: self.calls.append(text) or {"answers": {"tier": {"choice": "a", "confidence": 0.1, "probabilities": {"a": 0.85, "b": 0.15}}}})
        self.request = {"text": "Hello", "questions": {"tier": {"type": "choice", "instructions": "Choose", "criteria": {"a": "simple", "b": "hard"}}}}
    def test_valid(self):
        answer = predict(self.agent, self.request)["answers"]["tier"]
        self.assertEqual(answer["confidence"], 0.85)
        self.assertEqual(answer["probabilities"], {"a": 0.85, "b": 0.15})
        self.assertEqual(self.calls, ["Hello"])

    def test_uncertain_answer_stays_below_gate(self):
        self.agent.predict = lambda *_: {"answers": {"tier": {
            "choice": "b", "confidence": 0.03,
            "probabilities": {"a": 0.4, "b": 0.6}}}}
        self.assertEqual(predict(self.agent, self.request)["answers"]["tier"]["confidence"], 0.6)
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
