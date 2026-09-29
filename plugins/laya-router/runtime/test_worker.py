import json
import math
from pathlib import Path
from types import SimpleNamespace
import unittest
from worker import predict, calibrated_probabilities, correctness

ROOT=Path(__file__).resolve().parents[3]

class FakeTokenizer:
    mask_token='[MASK]'
    def __call__(self,text):return {'input_ids':list(range(math.ceil(len(text)/4)))}

class WorkerBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.calls=[]
        baseline=json.loads((ROOT/'eval-harness/routing/results/2026-09-29T17-32-52.218Z/metadata.json').read_text())
        self.criteria=baseline['criteria']
        self.raw={'basic':.9,'economy':.04,'general':.04,'advanced':.02}
        def infer(state,questions):
            self.calls.append((state,questions))
            return {'answers':{'tier':{'type':'choice','choice':'basic','confidence':.1,'probabilities':self.raw.copy()}}}
        self.agent=SimpleNamespace(tok=FakeTokenizer(),cfg={'max_len':1024,'head_max_len':256},predict=infer)
        self.request={'text':'Hello','questions':{'tier':{'type':'choice','instructions':'Choose','criteria':self.criteria.copy()}}}

    def test_json_state_and_calibrated_correctness_reach_the_caller(self):
        answer=predict(self.agent,self.request)['answers']['tier']
        self.assertEqual(self.calls[0][0],{'task':'Hello'})
        self.assertEqual(answer['choice'],'basic')
        self.assertGreater(answer['confidence'],.8)
        self.assertAlmostEqual(sum(answer['probabilities'].values()),1)
        self.assertNotEqual(answer['confidence'],answer['probabilities']['basic'])

    def test_custom_names_preserve_ordered_meaning(self):
        self.request['questions']['tier']['criteria']=dict(zip(['one','two','three','four'],self.criteria.values()))
        answer=predict(self.agent,self.request)['answers']['tier']
        self.assertEqual(answer['choice'],'one')
        self.assertEqual(list(answer['probabilities']),['one','two','three','four'])

    def test_three_tiers_combine_middle_probabilities(self):
        c=list(self.criteria.values())
        self.request['questions']['tier']['criteria']={'small':c[0],'medium':c[1]+' '+c[2],'large':c[3]}
        values=calibrated_probabilities(self.raw)
        answer=predict(self.agent,self.request)['answers']['tier']
        self.assertAlmostEqual(answer['probabilities']['medium'],values[1]+values[2])
        self.assertAlmostEqual(answer['confidence'],correctness(max(answer['probabilities'].values()),3))

    def test_oversize_state_is_not_silently_truncated(self):
        self.agent.cfg['max_len']=256
        self.request['text']='x'*1024
        with self.assertRaises(ValueError):predict(self.agent,self.request)
        self.assertEqual(self.calls,[])

    def test_oversize_head_is_not_silently_truncated(self):
        self.agent.cfg['head_max_len']=80
        with self.assertRaises(ValueError):predict(self.agent,self.request)
        self.assertEqual(self.calls,[])

    def test_changed_rubric_and_unknown_question_are_rejected(self):
        self.request['questions']['tier']['criteria']['basic']='Different task'
        with self.assertRaises(ValueError):predict(self.agent,self.request)
        self.request['questions']['other']={}
        with self.assertRaises(ValueError):predict(self.agent,self.request)
        self.assertEqual(self.calls,[])

    def test_invalid_native_probabilities_fail_closed(self):
        for value in [float('nan'),float('inf'),-.1,2]:
            with self.subTest(value=value):
                self.raw['basic']=value
                with self.assertRaises(ValueError):predict(self.agent,self.request)

    def test_extreme_distributions_stay_finite_and_normalized(self):
        values=calibrated_probabilities({'basic':1,'economy':0,'general':0,'advanced':0})
        self.assertTrue(all(math.isfinite(p) and 0<=p<=1 for p in values))
        self.assertAlmostEqual(sum(values),1)
        self.assertTrue(0<correctness(0,4)<correctness(1,4)<1)

if __name__=='__main__':unittest.main()
