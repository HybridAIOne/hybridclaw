"""Compare concrete tier rubrics on development data; freeze before validation.
All label aliases map back to the same four tiers, never to execution models.
"""
import argparse
import hashlib
import itertools
import json
import math
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parent
TIERS = ['basic', 'economy', 'general', 'advanced']
RUBRICS = {
    'baseline': [
        'Trivial arithmetic, greetings, simple facts.',
        'Everyday writing, translation or summarization.',
        'Programming, debugging, multi-step analysis.',
        'Research-level reasoning, hard proofs, complex system design.',
    ],
    'activities': [
        'Answer a simple factual question, greeting, unit conversion or short arithmetic calculation.',
        'Write or rewrite everyday text, translate, summarize, brainstorm or plan ordinary activities.',
        'Write code, debug software, explain a technical mechanism or analyze a multi-step practical problem.',
        'Prove a difficult theorem, conduct research or design a complex distributed system with rigorous tradeoffs.',
    ],
    'boundaries': [
        'Simple facts or arithmetic with a direct short answer. No drafting, programming or analysis.',
        'Everyday writing, translation, summarization and planning. No programming or technical troubleshooting.',
        'Programming, technical explanations, debugging and practical multi-step analysis. No research-level proof or complex architecture.',
        'Research-level math proofs, novel reasoning and complex system architecture with competing constraints.',
    ],
    'examples': [
        'Simple facts and calculations: capital cities, definitions, greetings, multiplication and unit conversions.',
        'Routine language tasks: emails, rewriting, translation, summarizing short text, meal plans and checklists.',
        'Technical work: scripts, SQL queries, debugging errors, explaining algorithms and comparing implementation options.',
        'Expert research: rigorous proofs, consensus algorithms, complex distributed architecture and deep theoretical analysis.',
    ],
}
QUESTIONS = {
    'category': 'Which category best describes the task?',
    'capability': "Choose the lowest capability level needed to complete the user's task.",
}

def variants():
    return [dict(name=f'{rubric}-{labels}-{question}', rubric=rubric,
                 labels=TIERS if labels == 'configured' else ['simple', 'routine', 'technical', 'expert'],
                 instructions=QUESTIONS[question], descriptions=RUBRICS[rubric])
            for rubric, labels, question in itertools.product(RUBRICS, ['configured', 'semantic'], QUESTIONS)]

def predict(agent, text, variant):
    criteria = dict(zip(variant['labels'], variant['descriptions']))
    def tokens(value):
        return len(agent.tok(value.replace(agent.tok.mask_token, ' '))['input_ids'])
    lengths = [tokens(' '+k+': '+v) for k,v in criteria.items()]
    head = tokens('choice question: '+variant['instructions']) + sum(n+1 for n in lengths)
    state = {'task': text}
    if max(lengths)>48 or head>agent.cfg['head_max_len'] or head+tokens(json.dumps(state,ensure_ascii=False))+4>agent.cfg['max_len']:
        raise ValueError('Prompt would truncate')
    result = agent.predict(state, {'tier': {'type':'choice', 'instructions':variant['instructions'], 'criteria':criteria}})
    probabilities = result['answers']['tier']['probabilities']
    probs = dict(zip(TIERS, (probabilities[k] for k in variant['labels'])))
    if not all(math.isfinite(p) and 0<=p<=1 for p in probs.values()) or abs(sum(probs.values())-1)>.002:
        raise ValueError('Invalid distribution')
    return probs

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--engine', required=True, choices=['laya-english','laya-typed-decisions','laya-multilingual'])
    p.add_argument('--model',required=True)
    args=p.parse_args()
    dataset=ROOT.parent/'dataset.json'
    source=ROOT.parent/'calibration/results'/f'{args.engine}.metadata.json'
    provenance=json.loads(source.read_text())['model']
    with (Path(args.model)/'model.safetensors').open('rb') as f:
        if hashlib.file_digest(f,'sha256').hexdigest()!=provenance['weight_sha256']:
            raise ValueError('Weights changed')
    output=ROOT/'results';output.mkdir(exist_ok=True)
    design=output/'design.json'
    frozen={'variants':variants(),'dataset_sha256':hashlib.sha256(dataset.read_bytes()).hexdigest(),
            'selection':'Highest development accuracy; ties retain declared order. No validation results used.',
            'state':'JSON task object', 'threshold':.8}
    if design.exists():
        if json.loads(design.read_text())!=frozen:raise ValueError('Design changed')
    else:design.write_text(json.dumps(frozen,indent=2)+'\n')
    rows_path=output/f'{args.engine}-dev.jsonl'
    if rows_path.exists():raise ValueError('Refuse overwrite')
    import laya_mlx
    agent=laya_mlx.load(args.model,dtype='float16')
    predict(agent,'What is 3 + 5?',variants()[0])
    rows_path.with_suffix('.metadata.json').write_text(json.dumps({'model':provenance,'design_sha256':hashlib.sha256(design.read_bytes()).hexdigest()},indent=2)+'\n')
    summaries=[]
    with rows_path.open('x') as f:
        for variant in variants():
            correct=0
            for case in json.loads(dataset.read_text())['cases']:
                started=time.perf_counter();probs=predict(agent,case['text'],variant)
                choice=max(probs,key=probs.get)
                row={'id':case['id'],'expected':case['expected'],'language':case['language'],'variant':variant['name'],
                     'choice':choice,'correct':choice==case['expected'],'probabilities':probs,'confidence':probs[choice],
                     'duration_ms':round((time.perf_counter()-started)*1000,3)}
                f.write(json.dumps(row)+'\n');correct+=row['correct']
            f.flush();summary={'variant':variant['name'],'correct':correct,'n':200}
            summaries.append(summary);print(args.engine,json.dumps(summary),flush=True)
    (output/f'{args.engine}-summary.json').write_text(json.dumps(summaries,indent=2)+'\n')
    best=max(range(len(summaries)),key=lambda i:summaries[i]['correct'])
    (output/f'{args.engine}-selected.json').write_text(json.dumps({'variant':variants()[best],'summary':summaries[best],
        'design_sha256':hashlib.sha256(design.read_bytes()).hexdigest()},indent=2)+'\n')

if __name__=='__main__':main()
