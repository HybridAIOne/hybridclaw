"""Select prompts on development only; evaluate frozen selections on fresh cases.
Uses upstream classifiers directly, without changing the gateway or tuning confidence.
"""
import argparse
import hashlib
from importlib.metadata import version, PackageNotFoundError
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def summarize(rows):
    valid = [r for r in rows if r.get('probabilities')]
    accepted = [r for r in valid if r['confidence'] >= .8]
    durations = sorted(r['duration_ms'] for r in rows)
    return {'n': len(rows), 'valid': len(valid), 'correct': sum(r.get('correct', False) for r in rows),
            'accepted': len(accepted), 'accepted_correct': sum(r['correct'] for r in accepted),
            'accepted_wrong': sum(not r['correct'] for r in accepted),
            'p50_ms': statistics.median(durations), 'p95_ms': durations[math.ceil(.95*len(durations))-1],
            'languages': {lang: {'n': sum(r['language']==lang for r in rows),
                                 'correct': sum(r.get('correct', False) and r['language']==lang for r in rows)} for lang in ['en','de']}}

def variants(engine, baseline):
    questions = {'difficulty': baseline['typedQuestion'], 'category': 'Which category best describes the task?',
                 'capability': "Choose the lowest capability level needed to complete the user's task."}
    if engine.startswith('laya-'):
        wording = 'difficulty' if engine == 'laya-multilingual' else 'capability'
        return [{'name': f'json-{wording}', 'state': 'json', 'question': questions[wording]}]
    if engine == 'horizon':
        questions = {'about': 'This task is about {}.', 'requires': 'Completing this task requires {}.',
                     'difficulty': 'The complexity of this task is best described as {}.'}
    return [{'name': f'{state}-{name}', 'state': state, 'question': question}
            for state in ['raw','json'] for name, question in questions.items()]

def load_predictor(engine, model, criteria, jeff_source, device):
    labels = list(criteria)
    descriptions = [f'{k}: {v}' for k,v in criteria.items()]
    if engine.startswith('laya-'):
        import laya_mlx
        agent = laya_mlx.load(model, dtype='float16')
        def predict(text, variant):
            state = {'task': text}
            result = agent.predict(state, {'tier': {'type':'choice', 'instructions':variant['question'], 'criteria':criteria}})
            return result['answers']['tier']['probabilities']
        return predict, lambda: None, 'mlx-float16'
    import torch
    torch.set_num_threads(4)
    if device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('MPS requested but unavailable')
    def sync():
        if device == 'mps': torch.mps.synchronize()
    if engine == 'jeff':
        sys.path.insert(0, str(Path(jeff_source)/'src'))
        from jeff.backends.torch_backend import TorchBackend
        from jeff.core.engine import Engine
        from jeff.core.groups import PromptOptions
        from jeff.core.schemas import SystemOneRequest
        backend = TorchBackend(model, device=device, dtype='float32', attn_kernel='eager', batch_size=1)
        agent = Engine(backend, 'gliformer-large-v1', opts=PromptOptions(state_format='json'))
        def predict(text, variant):
            state = {'task': text} if variant['state']=='json' else text
            result = agent.run(SystemOneRequest.model_validate({'model':'gliformer-large-v1','state':state, 'questions':{'tier':{'type':'choice','instructions':variant['question'],'criteria':criteria}}}))
            return result.answers['tier'].probabilities
    elif engine == 'gliclass':
        from gliclass import GLiClassModel, ZeroShotClassificationPipeline
        from transformers import AutoTokenizer
        agent = GLiClassModel.from_pretrained(model).float().to(device).eval()
        pipe = ZeroShotClassificationPipeline(agent, AutoTokenizer.from_pretrained(model), classification_type='single-label', device=device, progress_bar=False)
        def predict(text, variant):
            state = json.dumps({'task':text},ensure_ascii=False) if variant['state']=='json' else text
            with torch.inference_mode():
                out = pipe(state, descriptions, prompt=variant['question'], return_hierarchical=True)[0]
            return {label: out[desc] for label,desc in zip(labels,descriptions)}
    elif engine == 'horizon':
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        agent = AutoModelForSequenceClassification.from_pretrained(model, attn_implementation='eager').float().to(device).eval()
        tokenizer = AutoTokenizer.from_pretrained(model)
        entailment = next(int(k) for k,v in agent.config.id2label.items() if v.lower()=='entailment')
        def predict(text, variant):
            state = json.dumps({'task':text},ensure_ascii=False) if variant['state']=='json' else text
            hypotheses = [variant['question'].format(desc) for desc in descriptions]
            inputs = tokenizer([state]*len(labels), hypotheses, padding=True, truncation=False, return_tensors='pt').to(device)
            with torch.inference_mode():
                scores = torch.softmax(agent(**inputs).logits[:,entailment],dim=0).cpu().tolist()
            return dict(zip(labels,scores))
    else:
        raise ValueError(engine)
    return predict, sync, f'torch-{device}-float32'

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--engine',required=True,choices=['jeff','gliclass','horizon','laya-english','laya-multilingual','laya-typed-decisions'])
    p.add_argument('--phase',choices=['dev','test','smoke'],required=True)
    p.add_argument('--model',required=True)
    p.add_argument('--provenance',required=True,help='JSON with pinned repository/revision and hashes')
    p.add_argument('--jeff-source',default='/tmp/hybridclaw-jeff-eval')
    p.add_argument('--device',choices=['cpu','mps'],default='mps')
    p.add_argument('--output',required=True)
    args=p.parse_args()
    baseline=json.loads((ROOT.parent/'results/2026-09-29T17-32-52.218Z/metadata.json').read_text())
    dataset=ROOT/'holdout.json' if args.phase=='test' else ROOT.parent/'dataset.json'
    cases=json.loads(dataset.read_text())['cases']
    choices=variants(args.engine,baseline)
    folder=Path(args.output); folder.mkdir(parents=True,exist_ok=True)
    selection=folder/f'{args.engine}-selected.json'
    if args.phase=='test':
        if not all((folder/f'{e}-selected.json').exists() for e in ['jeff','gliclass','horizon']):
            raise ValueError('Freeze all development selections before held-out inference')
    if args.phase=='test' and not args.engine.startswith('laya-'):
        selected=json.loads(selection.read_text())
        assert selected['development_sha256']==digest(ROOT.parent/'dataset.json')
        choices=[selected['variant']]
    if args.phase=='smoke':
        cases=[cases[i] for i in [0,50,100,150]];choices=choices[:1]
    prefix=folder/f'{args.engine}-{args.phase}'
    if prefix.with_suffix('.jsonl').exists():raise ValueError('Run output already exists')
    provenance=json.loads(Path(args.provenance).read_text())
    packages={}
    for name in ['torch','transformers','gliclass','gliformer','laya-mlx','numpy']:
        try:packages[name]=version(name)
        except PackageNotFoundError:pass
    metadata={'engine':args.engine,'phase':args.phase,'dataset_sha256':digest(dataset),'variants':choices,
              'criteria':baseline['criteria'],'threshold':.8,'packages':packages,'model':provenance,
              'jeff_source_revision':subprocess.check_output(['git','-C',args.jeff_source,'rev-parse','HEAD'],text=True).strip() if args.engine=='jeff' else None,
              'protocol':'Serial, one request at a time, no retries or threshold fitting. Highest dev accuracy selects; ties retain declared order. Errors count wrong. One dev warmup excluded.'}
    prefix.with_suffix('.metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
    predict,sync,runtime=load_predictor(args.engine,args.model,baseline['criteria'],args.jeff_source,args.device)
    metadata['runtime']=runtime
    prefix.with_suffix('.metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
    # Fixed development prompt only; never warm up on the held-out set.
    warmup=json.loads((ROOT.parent/'dataset.json').read_text())['cases'][0]['text']
    predict(warmup,choices[0]);sync()
    summaries=[]
    with prefix.with_suffix('.jsonl').open('x') as stream:
        for variant in choices:
            rows=[]
            for case in cases:
                row={'id':case['id'],'variant':variant['name'],'language':case['language'],'expected':case['expected']}
                sync();started=time.perf_counter()
                try:
                    probs=predict(case['text'],variant);sync()
                    if set(probs)!=set(baseline['criteria']) or not all(math.isfinite(v) and 0<=v<=1 for v in probs.values()) or abs(sum(probs.values())-1)>.002:
                        raise ValueError('Invalid distribution')
                    chosen=max(probs,key=probs.get)
                    row.update(probabilities=probs,choice=chosen,confidence=probs[chosen],correct=chosen==case['expected'])
                except Exception as e:
                    row.update(error=f'{type(e).__name__}: {e}',correct=False)
                row['duration_ms']=round((time.perf_counter()-started)*1000,3)
                stream.write(json.dumps(row)+'\n');stream.flush();rows.append(row)
                if len(rows)>=3 and all(r.get('error') for r in rows[-3:]):raise RuntimeError('Three consecutive inference failures')
            summary={'variant':variant['name'],**summarize(rows)};summaries.append(summary)
            print(json.dumps(summary),flush=True)
    prefix.with_suffix('.summary.json').write_text(json.dumps(summaries,indent=2)+'\n')
    if args.phase=='dev':
        best=max(range(len(summaries)),key=lambda i:summaries[i]['correct'])
        selection.write_text(json.dumps({'development_sha256':digest(dataset),'variant':choices[best],'summary':summaries[best]},indent=2)+'\n')

if __name__=='__main__':main()
