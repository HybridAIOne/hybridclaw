"""Cache frozen Laya representations for supervised routing experiments.
Only synthetic development cases enter this cache; no live session is read.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ['dataset.json', 'calibration/test.json', 'prompting/validation.json',
           'alternatives/holdout.json']


def cases():
    rows = []
    for source in SOURCES:
        data = json.loads((ROOT/source).read_text())['cases']
        # Keeps the prompting dataset's translation pairs together; older sets
        # use ordinal groups and can still have cross-fold thematic overlap.
        counters = {}
        for case in data:
            key = (case['expected'], case['language'])
            ordinal = counters.get(key, 0)
            counters[key] = ordinal + 1
            rows.append({**case, 'source': source,
                         'group': f"{source}:{case['expected']}:{ordinal}"})
    return rows


def extract(agent, text, question):
    import mlx.core as mx
    from laya_mlx.common import build_prefix
    items, internal = agent.prepare({'task': text}, {'tier': question})
    item = items[0]
    prefix, _ = build_prefix(agent.tok, internal[0], agent.cfg['head_max_len'])
    # Independent reconstruction detects silent state truncation.
    state_ids = agent.tok(json.dumps({'task': text}, ensure_ascii=False).replace(agent.tok.mask_token, ' '),
                          add_special_tokens=False)['input_ids']
    if len(item['ids']) != len(prefix)+len(state_ids)+1:
        raise ValueError('State truncated')
    with mx.stream(agent.device):
        ids = mx.array([item['ids']]); mask = mx.ones(ids.shape, dtype=mx.bool_)
        encoder = agent.model.encoder(ids, mask)
        hidden = encoder + agent.model.type_emb(mx.array([item['qtype']]))[:, None, :]
        hidden = agent.model.head(hidden, mask[:, None, None, :])
        vectors = [encoder[0, len(prefix):-1].astype(mx.float32).mean(axis=0),
                   hidden[0, len(prefix):-1].astype(mx.float32).mean(axis=0),
                   hidden[0, item['markers']].astype(mx.float32).reshape(-1)]
        mx.eval(vectors)
    return [np.array(v) for v in vectors]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise ValueError('Refuse overwrite')
    variant = json.loads((ROOT/'prompting/affine.json').read_text())['variant']
    question = {'instructions': variant['instructions'],
                'criteria': dict(zip(variant['labels'], variant['descriptions'])), 'type': 'choice'}
    import laya_mlx
    agent = laya_mlx.load(args.model, dtype='float16')
    rows = cases(); features = [[], [], []]; durations = []
    for i, row in enumerate(rows):
        started = time.perf_counter()
        vectors = extract(agent, row['text'], question)
        durations.append((time.perf_counter()-started)*1000)
        for collected, vector in zip(features, vectors):
            collected.append(vector)
        if (i+1) % 100 == 0:
            print(f'{i+1}/{len(rows)}', flush=True)
    np.savez_compressed(output, **dict(zip(['encoder_state', 'head_state', 'head_markers'], features)))
    model = Path(args.model)
    with (model/'model.safetensors').open('rb') as f:
        weights = hashlib.file_digest(f, 'sha256').hexdigest()
    metadata = {'dtype': 'float16', 'weight_sha256': weights, 'rows': rows,
                'feature_sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
                'question': question, 'durations_ms': durations,
                'inputs': {s: hashlib.sha256((ROOT/s).read_bytes()).hexdigest() for s in SOURCES}}
    metadata['model_files_sha256'] = {str(p.relative_to(model)): hashlib.sha256(p.read_bytes()).hexdigest()
                                     for p in sorted(model.rglob('*.json')) if '.cache' not in p.parts}
    output.with_suffix('.json').write_text(json.dumps(metadata, indent=2)+'\n')


if __name__ == '__main__':
    main()
