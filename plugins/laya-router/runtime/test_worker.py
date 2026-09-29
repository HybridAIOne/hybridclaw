"""Routing input and numerical boundaries without downloading a model.
The unshipped production runner separately verifies actual MLX pipe decisions.
"""
import json
import math
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from worker import CALIBRATION, encode, predict, readout, verify

ROOT = Path(__file__).resolve().parents[3]


class FakeTokenizer:
    mask_token = '[MASK]'
    def __call__(self, text, **kwargs):
        return {'input_ids': list(range(math.ceil(len(text)/4)))}


class WorkerBoundaryTests(unittest.TestCase):
    def setUp(self):
        code = "import { routingTierCriteria } from './src/routing/policy.ts'; console.log(JSON.stringify(routingTierCriteria(['basic','economy','general','advanced'].map(name=>({name})))));"
        self.criteria = json.loads(subprocess.check_output(
            ['node', '--import', 'tsx', '--input-type=module', '-e', code], cwd=ROOT, text=True))
        self.features = [row[0] for row in CALIBRATION['matrix']]
        self.agent = SimpleNamespace(tok=FakeTokenizer(), cfg={'max_len': 1024, 'head_max_len': 256})
        self.request = {'text': 'Hello', 'questions': {'tier': {
            'type': 'choice', 'instructions': 'Choose', 'criteria': self.criteria.copy()}}}
        self.encoder = self.enterContext(patch('worker.encode', return_value=(self.features, 123)))

    def test_json_state_and_calibrated_distribution_reach_the_caller(self):
        result = predict(self.agent, self.request); answer = result['answers']['tier']
        self.encoder.assert_called_once_with(self.agent, {'task': 'Hello'}, CALIBRATION['question'])
        self.assertEqual(answer['choice'], 'basic')
        self.assertGreater(answer['confidence'], .8)
        self.assertAlmostEqual(sum(answer['probabilities'].values()), 1)
        self.assertEqual(answer['confidence'], max(answer['probabilities'].values()))
        self.assertEqual(result['usage'], {'input_tokens': 123, 'output_tokens': 0})

    def test_custom_names_preserve_ordered_meaning(self):
        self.request['questions']['tier']['criteria'] = dict(zip(['one', 'two', 'three', 'four'], self.criteria.values()))
        answer = predict(self.agent, self.request)['answers']['tier']
        self.assertEqual(answer['choice'], 'one')
        self.assertEqual(list(answer['probabilities']), ['one', 'two', 'three', 'four'])

    def test_three_tiers_combine_middle_probabilities(self):
        c = list(self.criteria.values())
        self.request['questions']['tier']['criteria'] = {'small': c[0], 'medium': c[1]+' '+c[2], 'large': c[3]}
        values = readout(self.features)
        answer = predict(self.agent, self.request)['answers']['tier']
        self.assertAlmostEqual(answer['probabilities']['medium'], values[1]+values[2])
        self.assertEqual(answer['confidence'], max(answer['probabilities'].values()))

    def test_oversize_state_and_head_are_not_silently_truncated(self):
        for config, text in [({'max_len': 256, 'head_max_len': 256}, 'x'*1024),
                             ({'max_len': 1024, 'head_max_len': 80}, 'Hello')]:
            with self.subTest(config=config):
                self.agent.cfg = config; self.request['text'] = text
                with self.assertRaises(ValueError):
                    predict(self.agent, self.request)
        self.encoder.assert_not_called()

    def test_changed_rubric_unknown_question_and_invalid_input_are_rejected(self):
        requests = [
            {'text': '', 'questions': self.request['questions']},
            {'text': None, 'questions': self.request['questions']},
            {'text': 'Hello', 'questions': {'other': {}}},
            {'text': 'Hello', 'questions': {'tier': {'type': 'score', 'criteria': self.criteria}}},
            {'text': 'Hello', 'questions': {'tier': {'type': 'choice', 'criteria': {'one': 'different'}}}},
        ]
        self.request['questions']['tier']['criteria']['basic'] = 'Different task'
        for request in [*requests, self.request]:
            with self.subTest(request=request), self.assertRaises(ValueError):
                predict(self.agent, request)
        self.encoder.assert_not_called()

    def test_invalid_encoder_outputs_fail_closed(self):
        for value in [float('nan'), float('inf'), 1e308]:
            features = self.features.copy(); features[0] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                readout(features)
        for features in [[], self.features[:-1], [0.]*len(self.features)]:
            with self.assertRaises(ValueError):
                readout(features)

    def test_readout_is_scale_invariant_and_stable_for_large_logits(self):
        values = readout(self.features)
        scaled = readout([v*10000 for v in self.features])
        self.assertTrue(all(math.isfinite(p) and 0 <= p <= 1 for p in values))
        self.assertAlmostEqual(sum(values), 1)
        for expected, actual in zip(values, scaled):
            self.assertAlmostEqual(expected, actual)

    def test_changed_model_configuration_fails_integrity_verification(self):
        with patch('worker.hashlib.file_digest', return_value=SimpleNamespace(hexdigest=lambda: CALIBRATION['weight_sha256'])), \
             patch('pathlib.Path.open'), patch('pathlib.Path.read_bytes', return_value=b'changed'):
            with self.assertRaisesRegex(ValueError, 'configuration integrity'):
                verify(Path('/tmp/model'))

    def test_encoder_rejects_silently_truncated_prepared_tokens(self):
        self.agent.prepare = lambda state, questions: ([{'ids': [1, 2], 'markers': [0, 1, 2, 3]}], [{}])
        core = SimpleNamespace()
        common = SimpleNamespace(build_prefix=lambda *args: ([1], [0, 1, 2, 3]))
        modules = {'mlx': SimpleNamespace(core=core), 'mlx.core': core,
                   'laya_mlx': SimpleNamespace(common=common), 'laya_mlx.common': common}
        with patch.dict('sys.modules', modules), self.assertRaisesRegex(ValueError, 'truncated'):
            encode(self.agent, {'task': 'Hello'}, CALIBRATION['question'])

    def test_changed_weights_fail_integrity_verification(self):
        with patch('worker.hashlib.file_digest', return_value=SimpleNamespace(hexdigest=lambda: 'changed')), patch('pathlib.Path.open'):
            with self.assertRaisesRegex(ValueError, 'Model integrity'):
                verify(Path('/tmp/model'))


if __name__ == '__main__':
    unittest.main()
