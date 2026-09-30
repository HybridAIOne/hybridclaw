"""Run JevBench's public tasks through its adapters, runner and scorer.
Only aggregate exports enter this checkout; raw responses stay in a private run directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from importlib.metadata import version

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--engine', choices=['jev', 'gemma', 'laya-english', 'laya-multilingual', 'laya-typed-decisions'], required=True)
parser.add_argument('--model-dir')
parser.add_argument('--checkpoint')
parser.add_argument('--private-dir', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--smoke', action='store_true')
args = parser.parse_args()
source = Path(args.source).resolve()
sys.path.insert(0, str(source))
from jevbench.adapters.typesafe import TypeSafeAdapter
from jevbench.adapters.openai_compat import OpenAICompatAdapter
from jevbench.adapters.laya_local import LayaLocalAdapter
from jevbench.adapters.base import build_question
from jevbench.runner import Runner
from jevbench.budget import Ledger
from jevbench.tasks import load_jsonl
from jevbench.summarize import public_export, metric

cohorts = {name: load_jsonl(source / f'datasets/public/{name}.jsonl') for name in ['easy', 'original', 'hard']}
tasks = [task for group in cohorts.values() for task in group]
if args.smoke:
    tasks = [next(t for t in tasks if t.question['type'] == kind) for kind in ['choice', 'score', 'noul']] + [cohorts['hard'][0]]
private = Path(args.private_dir).resolve()
output = Path(args.output).resolve()
if private.is_relative_to(Path(__file__).resolve().parents[2]):
    raise ValueError('Raw evidence must stay outside this checkout')
private.mkdir(parents=True, exist_ok=True)
output.mkdir(parents=True, exist_ok=True)
label = args.engine + ('-smoke' if args.smoke else '')
metadata = {'source': 'https://github.com/fstandhartinger/jevbench',
            'revision': subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
            'dataset_sha256': {name: hashlib.sha256((source / f'datasets/public/{name}.jsonl').read_bytes()).hexdigest() for name in cohorts},
            'n_planned': len(tasks), 'engine': args.engine, 'smoke': args.smoke,
            'protocol': 'Public subset only; canonical state/question unchanged; upstream Runner and scorer; no confidence abstention or retries; 120s request timeout.'}

class MLXAdapter(LayaLocalAdapter):
    name = 'laya_mlx'
    cost_basis = 'local_mlx_no_provider_tariff'
    def load(self):
        if self._agent is None:
            import laya_mlx
            self._agent = laya_mlx.load(self.path, dtype='float16')
        return self._agent
    def run(self, task):
        result = super().run(task)
        if isinstance(result.raw, dict):
            from laya_mlx.common import build_prefix, serialize_state
            agent = self.load()
            q = agent._to_internal(build_question(task))
            prefix, _ = build_prefix(agent.tok, q, agent.cfg['head_max_len'])
            text = serialize_state(task.state).replace(agent.tok.mask_token, ' ')
            tokens = len(agent.tok(text, add_special_tokens=False)['input_ids'])
            result.raw['runtime'] = {'device': 'mlx', 'dtype': 'float16', 'laya_mlx': version('laya-mlx'),
                                     'max_len': agent.cfg['max_len'], 'head_max_len': agent.cfg['head_max_len'],
                                     'state_truncated': tokens + len(prefix) + 1 > agent.cfg['max_len']}
        return result

if args.engine == 'jev':
    adapter = TypeSafeAdapter(model='jev-latest', key_env='JEVBENCH_JEV_KEY', timeout_s=120)
elif args.engine == 'gemma':
    adapter = OpenAICompatAdapter(endpoint=os.environ['JEVBENCH_GEMMA_URL'], model=os.environ['JEVBENCH_GEMMA_MODEL'], key_env='JEVBENCH_GEMMA_KEY', timeout_s=120)
    metadata['output_constraint'] = 'strict JSON schema; upstream prompt; verbalized probabilities'
else:
    if not args.model_dir or not args.checkpoint:
        raise ValueError('Local runs require --model-dir and --checkpoint')
    adapter = MLXAdapter(endpoint=args.model_dir, model=args.checkpoint, revision=args.checkpoint.split('@')[-1])
    adapter.load()  # Exclude model loading from inference timing.
    with (Path(args.model_dir) / 'model.safetensors').open('rb') as stream:
        metadata['weight_sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
    metadata.update(checkpoint=args.checkpoint, runtime=f'laya-mlx=={version("laya-mlx")}', model_config=adapter._agent.cfg, dtype='float16')
(output / f'{label}-metadata.json').write_text(json.dumps(metadata, indent=2)+'\n')
ledger = Ledger(private / 'ledger.jsonl', cap_usd=10)
runner = Runner(adapter, ledger, private / label / 'raw', default_reserve_usd=0 if args.engine.startswith('laya') else .02)
records = runner.run_all(tasks, results_path=private / label / 'results.jsonl')
summary = public_export({}, tasks, records)
summary['cohorts'] = {name: metric([t for t in group if t in tasks], records) for name, group in cohorts.items()}
summary['question_types'] = {kind: metric([t for t in tasks if t.question['type']==kind], records) for kind in ['choice', 'score', 'noul']}
summary['state_truncated_count'] = sum(bool((r.get('runtime') or {}).get('state_truncated')) for r in records) if args.engine.startswith('laya') else None
if args.engine.startswith('laya'):
    untruncated = [r for r in records if not (r.get('runtime') or {}).get('state_truncated')]
    summary['untruncated_state'] = {'n': len(untruncated), 'correct': sum(bool(r.get('correct')) for r in untruncated)}
(output / f'{label}-summary.json').write_text(json.dumps(summary, indent=2)+'\n')
print(json.dumps({'engine': args.engine, 'attempted': summary['n_attempted'], 'correct': summary['n_correct'], 'accuracy': summary['accuracy'], 'complete': summary['complete']}), flush=True)
if not summary['complete']:
    sys.exit(2)
