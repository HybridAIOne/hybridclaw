"""Run the frozen routing candidate on calibration or fresh validation cases.
Calibration labels fit confidence only after predictions; test labels never fit.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
from run import predict

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'calibration'))
from calibrate import calibrated
from specialize import transform

def main():
    p=argparse.ArgumentParser();p.add_argument('--phase',choices=['calibration','validation'],required=True);p.add_argument('--model',required=True);args=p.parse_args()
    affine=ROOT/'affine.json';config=json.loads(affine.read_text())
    dataset=ROOT.parent/'alternatives/holdout.json' if args.phase=='calibration' else ROOT/'validation.json'
    frozen=ROOT/'candidate.json'
    if args.phase=='validation':
        candidate=json.loads(frozen.read_text());assert candidate['affine_sha256']==hashlib.sha256(affine.read_bytes()).hexdigest()
    metadata=json.loads((ROOT/'results/laya-typed-decisions-dev.metadata.json').read_text())
    with (Path(args.model)/'model.safetensors').open('rb') as f:
        assert hashlib.file_digest(f,'sha256').hexdigest()==metadata['model']['weight_sha256']
    path=ROOT/'results'/f'{args.phase}.jsonl'
    if path.exists():raise ValueError('Refuse overwrite')
    import laya_mlx
    agent=laya_mlx.load(args.model,dtype='float16');predict(agent,'What is 3 + 5?',config['variant'])
    records=[]
    with path.open('x') as f:
        for case in json.loads(dataset.read_text())['cases']:
            start=time.perf_counter();raw=predict(agent,case['text'],config['variant']);probs=transform(raw,config)
            choice=max(probs,key=probs.get);confidence=probs[choice]
            row={**{k:case[k] for k in ['id','language','expected']},'raw_probabilities':raw,'probabilities':probs,
                 'choice':choice,'correct':choice==case['expected'],'confidence':confidence,'duration_ms':round((time.perf_counter()-start)*1000,3)}
            if args.phase=='validation':row['calibrated']=calibrated(confidence,candidate['correctness']['a'],candidate['correctness']['b'])
            records.append(row);f.write(json.dumps(row)+'\n');f.flush()
    provenance={'model':metadata['model'],'affine_sha256':hashlib.sha256(affine.read_bytes()).hexdigest(),
                'dataset_sha256':hashlib.sha256(dataset.read_bytes()).hexdigest()}
    if args.phase=='validation':provenance['candidate_sha256']=hashlib.sha256(frozen.read_bytes()).hexdigest()
    path.with_suffix('.metadata.json').write_text(json.dumps(provenance,indent=2)+'\n')
    print(args.phase,'correct',sum(r['correct'] for r in records),'/',len(records),flush=True)

if __name__=='__main__':main()
