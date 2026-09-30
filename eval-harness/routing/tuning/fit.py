"""Select a frozen-feature readout on grouped development folds.
The older alternatives holdout is reserved for confidence fitting, never selection.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from scipy.special import logsumexp, softmax

LABELS = ['basic', 'economy', 'general', 'advanced']
REPRESENTATIONS = ['encoder_state', 'head_state', 'head_markers']
PENALTIES = [.0001, .001, .01, .1]


def normalize(x):
    return x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-8)


def train(x, y, penalty):
    d = x.shape[1]
    targets = np.eye(4)[y]
    def objective(t):
        w = t[:d*4].reshape(d, 4); b = t[d*4:]
        logits = x@w+b
        loss = np.mean(logsumexp(logits, axis=1)-logits[np.arange(len(y)), y])
        error = (softmax(logits, axis=1)-targets)/len(y)
        gradient = np.r_[(x.T@error+penalty*w).reshape(-1), error.sum(axis=0)]
        return loss+penalty*np.sum(w*w)/2, gradient
    result = minimize(objective, np.zeros(d*4+4), jac=True, method='L-BFGS-B',
                      options={'maxiter': 500, 'gtol': 1e-6})
    if not result.success:
        raise RuntimeError(result.message)
    return result.x[:d*4].reshape(d, 4), result.x[d*4:]


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--features', required=True)
    parser.add_argument('--output', required=True); args = parser.parse_args()
    path = Path(args.features); output = Path(args.output)
    if output.exists():
        raise ValueError('Refuse overwrite')
    meta = json.loads(path.with_suffix('.json').read_text())
    if hashlib.sha256(path.read_bytes()).hexdigest() != meta['feature_sha256']:
        raise ValueError('Feature cache changed')
    arrays = np.load(path); rows = meta['rows']
    development = np.array([r['source'] != 'alternatives/holdout.json' for r in rows])
    folds = np.array([int(r['group'].rsplit(':', 1)[1]) % 5 for r in rows])
    y = np.array([LABELS.index(r['expected']) for r in rows])
    results = []; predictions = []
    for representation in REPRESENTATIONS:
        x = normalize(arrays[representation].astype(np.float64))
        for penalty in PENALTIES:
            probabilities = np.zeros((len(rows), 4))
            for fold in range(5):
                train_mask = development & (folds != fold)
                test_mask = development & (folds == fold)
                w, b = train(x[train_mask], y[train_mask], penalty)
                probabilities[test_mask] = softmax(x[test_mask]@w+b, axis=1)
            choice = probabilities.argmax(axis=1)
            for i in np.flatnonzero(development):
                predictions.append({'id': rows[i]['id'], 'source': rows[i]['source'], 'group': rows[i]['group'],
                                    'fold': int(folds[i]), 'representation': representation, 'penalty': penalty,
                                    'expected': LABELS[int(y[i])], 'choice': LABELS[int(choice[i])],
                                    'probabilities': probabilities[i].tolist()})
            summary = {'representation': representation, 'penalty': penalty,
                       'correct': int(np.sum(choice[development] == y[development])),
                       'n': int(development.sum()),
                       'nll': float(np.mean(-np.log(probabilities[development, y[development]]))),
                       'by_language': {language: int(np.sum((choice == y)&development&
                            np.array([r['language'] == language for r in rows]))) for language in ['en', 'de']}}
            results.append(summary); print(json.dumps(summary), flush=True)
    # Accuracy first, NLL breaks ties. The calibration slice is still unread.
    selected = min(results, key=lambda r: (-r['correct'], r['nll']))
    x = normalize(arrays[selected['representation']].astype(np.float64))
    w, b = train(x[development], y[development], selected['penalty'])
    config = {'labels': LABELS, 'representation': selected['representation'], 'normalization': 'l2',
              'weight_sha256': meta['weight_sha256'], 'dtype': meta['dtype'], 'question': meta['question'],
              'matrix': w.tolist(), 'bias': b.tolist(), 'selected': selected,
              'development_cv': results, 'feature_sha256': meta['feature_sha256'],
              'inputs': meta['inputs'], 'gate': .8}
    config['model_files_sha256'] = meta['model_files_sha256']
    output.write_text(json.dumps(config, indent=2)+'\n')
    with output.with_suffix('.cv.jsonl').open('x') as f:
        for row in predictions:
            f.write(json.dumps(row)+'\n')
    calibration = ~development
    logits = x[calibration]@w+b; labels = y[calibration]
    def objective(t):
        z = logits/np.exp(t[0])
        return float(np.mean(logsumexp(z, axis=1)-z[np.arange(len(labels)), labels]))
    temperature = minimize(objective, [0.], method='L-BFGS-B', bounds=[(-2.302585093, 2.302585093)])
    if not temperature.success:
        raise RuntimeError(temperature.message)
    config['temperature'] = float(np.exp(temperature.x[0]))
    probabilities = softmax(logits/config['temperature'], axis=1)
    correct = probabilities.argmax(axis=1) == labels
    accepted = probabilities.max(axis=1) >= .8
    config['calibration'] = {'correct': int(correct.sum()), 'n': int(calibration.sum()),
                             'accepted': int(accepted.sum()), 'accepted_correct': int((accepted&correct).sum())}
    output.write_text(json.dumps(config, indent=2)+'\n')
    print('Selected:', json.dumps(selected), 'Calibration:', json.dumps(config['calibration']), flush=True)


if __name__ == '__main__':
    main()
