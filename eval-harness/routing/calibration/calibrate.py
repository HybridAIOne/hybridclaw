"""Fit monotone correctness calibration without changing any predicted tier.
The old holdout becomes calibration data; fresh test labels never enter fitting.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

ROOT=Path(__file__).resolve().parent
ENGINES=['laya-english','laya-typed-decisions','laya-multilingual']

def logit(p):
    p=min(1-1e-6,max(1e-6,p))
    return math.log(p/(1-p))

def calibrated(p,a,b):
    z=a*logit(p)+b
    return 1/(1+math.exp(-z)) if z>=0 else math.exp(z)/(1+math.exp(z))

def fit(rows):
    import numpy as np
    from scipy.optimize import minimize
    x=np.array([logit(r['confidence']) for r in rows])
    y=np.array([float(r['correct']) for r in rows])
    def objective(theta):
        a,b=theta;z=a*x+b
        return float(np.mean(np.logaddexp(0,z)-y*z)+.001*(a*a+b*b))
    result=minimize(objective,[1.,0.],method='L-BFGS-B',bounds=[(.01,20),(-20,20)])
    if not result.success:raise RuntimeError(result.message)
    return {'a':float(result.x[0]),'b':float(result.x[1]),'objective':float(result.fun)}

def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True);args=p.parse_args()
    out=Path(args.output)
    if out.exists():raise ValueError('Refuse to overwrite frozen calibration')
    models={}
    for engine in ENGINES:
        source=ROOT.parent/'alternatives/results'/f'{engine}-test.jsonl'
        rows=[json.loads(l) for l in source.read_text().splitlines()]
        assert len(rows)==120 and all('confidence' in r for r in rows)
        models[engine]={**fit(rows),'n':len(rows),'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest()}
    out.write_text(json.dumps({'method':'sigmoid(a*logit(selected_probability)+b), a>0; mean binary NLL + 0.001*(a²+b²); fixed gates 0.8 and 0.95','models':models},indent=2)+'\n')

if __name__=='__main__':main()
