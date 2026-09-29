"""Generate the plugin calibration from frozen evidence and the shared rubric.
No coefficient or description is maintained independently in production.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'calibration'))
from calibrate import fit

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args()
    affine=json.loads((ROOT/'affine.json').read_text());candidate=json.loads((ROOT/'candidate.json').read_text())
    metadata=json.loads((ROOT/'results/laya-typed-decisions-dev.metadata.json').read_text())['model']
    code="""import { routingTierCriteria } from './src/routing/policy.ts';
import { createHash } from 'node:crypto';
const out={};for(const n of [3,4])out[n]=createHash('sha256').update(JSON.stringify(Object.values(routingTierCriteria(Array.from({length:n},(_,i)=>({name:String(i)})))))).digest('hex');
console.log(JSON.stringify(out));"""
    fingerprints=json.loads(subprocess.check_output(['node','--import','tsx','--input-type=module','-e',code],cwd=ROOT.parents[2],text=True))
    rows=[]
    for r in map(json.loads,(ROOT/'results/calibration.jsonl').read_text().splitlines()):
        p=r['probabilities'];probs={'basic':p['basic'],'middle':p['economy']+p['general'],'advanced':p['advanced']}
        choice=max(probs,key=probs.get);expected='middle' if r['expected'] in ['economy','general'] else r['expected']
        rows.append({'confidence':probs[choice],'correct':choice==expected})
    config={'repo':'aac6fef/laya-typed-decisions-mlx','revision':metadata['checkpoint'].split('@')[1],
            'weight_sha256':metadata['weight_sha256'],'instructions':affine['variant']['instructions'],
            'criteria':dict(zip(affine['labels'],affine['variant']['descriptions'])),'matrix':affine['matrix'],'bias':affine['bias'],
            'correctness':{'4':candidate['correctness'],'3':fit(rows)},'gateway_rubric_sha256':fingerprints,
            'provenance':{'affine_sha256':candidate['affine_sha256'],'calibration_sha256':candidate['calibration_sha256'],
                          'validation_sha256':hashlib.sha256((ROOT/'validation.json').read_bytes()).hexdigest()}}
    with Path(args.output).open('x') as f:f.write(json.dumps(config,indent=2)+'\n')

if __name__=='__main__':main()
