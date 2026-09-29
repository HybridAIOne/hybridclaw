"""One fresh pass of the frozen readout; no labels enter model selection.
Keep full distributions for auditing calibration independently of accuracy.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np
from features import extract

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--model', required=True)
    args = parser.parse_args()
    candidate = ROOT/'candidate.json'; config = json.loads(candidate.read_text())
    dataset = ROOT/'test.json'; data = json.loads(dataset.read_text())
    assert data['candidate_sha256'] == hashlib.sha256(candidate.read_bytes()).hexdigest()
    model = Path(args.model)
    with (model/'model.safetensors').open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == config['weight_sha256']
    for name, digest in config['model_files_sha256'].items():
        assert hashlib.sha256((model/name).read_bytes()).hexdigest() == digest
    output = ROOT/'results/candidate.jsonl'
    if output.exists():
        raise ValueError('Refuse overwrite')
    import laya_mlx
    agent = laya_mlx.load(args.model, dtype=config['dtype'])
    extract(agent, 'Compute 13 plus 4.', config['question'])
    w = np.array(config['matrix']); b = np.array(config['bias'])
    rows = []
    with output.open('x') as f:
        for case in data['cases']:
            started = time.perf_counter()
            x = extract(agent, case['text'], config['question'])[0].astype(np.float64)
            x /= max(np.linalg.norm(x), 1e-8)
            z = (x@w+b)/config['temperature']; p = np.exp(z-z.max()); p /= p.sum()
            choice = config['labels'][int(p.argmax())]
            row = {k: case[k] for k in ['id', 'language', 'expected']}
            row.update(choice=choice, correct=choice == case['expected'], confidence=float(p.max()),
                       probabilities=dict(zip(config['labels'], p.tolist())),
                       duration_ms=round((time.perf_counter()-started)*1000, 3))
            rows.append(row); f.write(json.dumps(row)+'\n')
    output.with_suffix('.metadata.json').write_text(json.dumps({
        'candidate_sha256': hashlib.sha256(candidate.read_bytes()).hexdigest(),
        'dataset_sha256': hashlib.sha256(dataset.read_bytes()).hexdigest(),
        'feature_extractor_sha256': hashlib.sha256((ROOT/'features.py').read_bytes()).hexdigest(),
        'model_files_sha256': config['model_files_sha256'], 'weight_sha256': config['weight_sha256'],
        'latency_note': 'Includes unused frozen transformer head for experiment parity; production readout only needs the encoder.'}, indent=2)+'\n')
    accepted = [r for r in rows if r['confidence'] >= .8]
    print('Correct', sum(r['correct'] for r in rows), '/', len(rows),
          'Accepted', len(accepted), 'correct', sum(r['correct'] for r in accepted))


if __name__ == '__main__':
    main()
