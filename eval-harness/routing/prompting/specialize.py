"""Freeze a four-class affine calibration before held-out correctness fitting.
Training uses development records only; future validation labels cannot enter it.
"""
import hashlib
import argparse
import json
from pathlib import Path
import sys
import numpy as np

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'calibration'))
from calibrate import fit

LABELS=['basic','economy','general','advanced']

def features(probabilities):
    x=np.log(np.maximum(1e-8, [[r[k] for k in LABELS] for r in probabilities]))
    return x-x.mean(axis=1,keepdims=True)

def transform(probabilities, config):
    z=features([probabilities])@np.array(config['matrix'])+np.array(config['bias'])
    z-=z.max(axis=1,keepdims=True);p=np.exp(z);p/=p.sum(axis=1,keepdims=True)
    return dict(zip(LABELS,p[0].tolist()))

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--correctness',action='store_true');args=parser.parse_args()
    if args.correctness:
        source=ROOT/'results/calibration.jsonl';rows=[json.loads(l) for l in source.read_text().splitlines()]
        assert len(rows)==120
        config={'affine_sha256':hashlib.sha256((ROOT/'affine.json').read_bytes()).hexdigest(),
                'correctness':fit(rows),'gate':.8,'calibration_sha256':hashlib.sha256(source.read_bytes()).hexdigest()}
        with (ROOT/'candidate.json').open('x') as f:f.write(json.dumps(config,indent=2)+'\n')
        print('Frozen correctness map',flush=True);return
    from scipy.optimize import minimize
    source=ROOT/'results/laya-typed-decisions-dev.jsonl'
    selection=json.loads((ROOT/'results/laya-typed-decisions-selected.json').read_text())
    assert selection['variant']['name']=='activities-configured-category'
    rows=[json.loads(l) for l in source.read_text().splitlines() if json.loads(l)['variant']==selection['variant']['name']]
    assert len(rows)==200
    x=features([r['probabilities'] for r in rows]);y=np.array([LABELS.index(r['expected']) for r in rows])
    initial=np.r_[np.eye(4).reshape(-1),np.zeros(4)]
    def objective(t):
        z=x@t[:16].reshape(4,4)+t[16:];z-=z.max(axis=1,keepdims=True)
        return float(np.mean(np.log(np.exp(z).sum(axis=1))-z[np.arange(len(y)),y])+.01*np.mean((t-initial)**2))
    result=minimize(objective,initial,method='L-BFGS-B')
    if not result.success:raise RuntimeError(result.message)
    config={'engine':'laya-typed-decisions','variant':selection['variant'],'labels':LABELS,
            'matrix':result.x[:16].reshape(4,4).tolist(),'bias':result.x[16:].tolist(),
            'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'penalty':.01,
            'method':'softmax(centered_log(p) @ matrix + bias); mean multiclass NLL + penalty*mean squared departure from identity'}
    path=ROOT/'affine.json'
    with path.open('x') as f:f.write(json.dumps(config,indent=2)+'\n')
    print('Frozen affine map',flush=True)

if __name__=='__main__':main()
