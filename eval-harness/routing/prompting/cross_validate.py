"""Reproduce the development-only calibration search, retaining every result.
Prompt selection already uses development data, so these folds are exploratory.
"""
import json
import hashlib
from pathlib import Path
import numpy as np
from scipy.optimize import minimize
from specialize import features, LABELS

ROOT=Path(__file__).resolve().parent

def main():
    source=ROOT/'results/laya-typed-decisions-dev.jsonl'
    rows=[json.loads(l) for l in source.read_text().splitlines() if json.loads(l)['variant']=='activities-configured-category']
    x=features([r['probabilities'] for r in rows]);y=np.array([LABELS.index(r['expected']) for r in rows])
    folds=np.array([int(r['id'].split('-')[-1])%5 for r in rows]);results=[]
    for method in ['bias','vector','matrix']:
        for penalty in [.001,.01,.1,1]:
            predictions={}
            for fold in range(5):
                train=folds!=fold;test=folds==fold
                def logits(theta,data):
                    if method=='bias':return data+theta
                    if method=='vector':return data*np.exp(theta[:4])+theta[4:]
                    return data@theta[:16].reshape(4,4)+theta[16:]
                initial=np.zeros(4 if method=='bias' else 8 if method=='vector' else 20)
                if method=='matrix':initial[:16]=np.eye(4).reshape(-1)
                def objective(t):
                    z=logits(t,x[train]);z-=z.max(axis=1,keepdims=True)
                    return float(np.mean(np.log(np.exp(z).sum(axis=1))-z[np.arange(sum(train)),y[train]])+penalty*np.mean((t-initial)**2))
                result=minimize(objective,initial,method='L-BFGS-B')
                if not result.success:raise RuntimeError(result.message)
                for i,choice in zip(np.where(test)[0],logits(result.x,x[test]).argmax(axis=1)):
                    predictions[rows[i]['id']]=LABELS[choice]
            correct=sum(predictions[r['id']]==r['expected'] for r in rows)
            results.append({'method':method,'penalty':penalty,'correct':correct,'n':len(rows),'predictions':predictions})
    best=max(results,key=lambda r:r['correct'])
    assert (best['method'],best['penalty'],best['correct'])==('matrix',.01,165)
    with (ROOT/'results/cross-validation.json').open('x') as f:
        f.write(json.dumps({'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'results':results},indent=2)+'\n')
    print('Reproduced all 12 development fits; selected matrix .01: 165/200')

if __name__=='__main__':main()
