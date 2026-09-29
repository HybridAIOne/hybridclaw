"""Apply frozen correctness maps to fresh predictions; never fit on test labels."""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import time
from calibrate import ENGINES, calibrated

ROOT=Path(__file__).resolve().parent

def main():
    p=argparse.ArgumentParser();p.add_argument('--engine',choices=ENGINES,required=True);p.add_argument('--model',required=True);args=p.parse_args()
    frozen=ROOT/'frozen.json';test=ROOT/'test.json'
    config=json.loads(frozen.read_text())['models'][args.engine]
    source=ROOT.parent/'alternatives/results'/f'{args.engine}-test.jsonl'
    assert hashlib.sha256(source.read_bytes()).hexdigest()==config['source_sha256']
    previous=json.loads(source.with_suffix('.metadata.json').read_text())
    with (Path(args.model)/'model.safetensors').open('rb') as stream:
        assert hashlib.file_digest(stream,'sha256').hexdigest()==previous['model']['weight_sha256']
    spec=importlib.util.spec_from_file_location('alternative_runner',ROOT.parent/'alternatives/run.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    output=ROOT/'results';output.mkdir(exist_ok=True)
    path=output/f'{args.engine}.jsonl'
    if path.exists():raise ValueError('Existing test output; no silent reruns')
    predict,sync,runtime=module.load_predictor(args.engine,args.model,previous['criteria'],'','mps')
    variant=previous['variants'][0]
    predict('What is 3 + 5?',variant);sync()
    metadata={'model':previous['model'],'variant':variant,'criteria':previous['criteria'],'runtime':runtime,'calibration':config,
              'frozen_sha256':hashlib.sha256(frozen.read_bytes()).hexdigest(),'test_sha256':hashlib.sha256(test.read_bytes()).hexdigest()}
    path.with_suffix('.metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
    with path.open('x') as stream:
        for case in json.loads(test.read_text())['cases']:
            start=time.perf_counter();probs=predict(case['text'],variant);sync()
            assert set(probs)==set(previous['criteria']) and all(math.isfinite(v) and 0<=v<=1 for v in probs.values()) and abs(sum(probs.values())-1)<.002
            choice=max(probs,key=probs.get);confidence=probs[choice]
            row={'id':case['id'],'expected':case['expected'],'language':case['language'],'choice':choice,'correct':choice==case['expected'],
                 'probabilities':probs,'raw':confidence,'calibrated':calibrated(confidence,config['a'],config['b']),'duration_ms':round((time.perf_counter()-start)*1000,3)}
            stream.write(json.dumps(row)+'\n');stream.flush()
    print(args.engine,'complete',flush=True)

if __name__=='__main__':main()
