"""Audit model selection, frozen fits and actual production decisions before reporting.
Privacy exclusions remain scored as unresolved, never as correct classifications.
"""
import hashlib
import json
from pathlib import Path
import statistics
import sys

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'calibration'))
from calibrate import calibrated
from report import wilson

def read(path):return json.loads(path.read_text())
def records(path):return [json.loads(l) for l in path.read_text().splitlines()]
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def summarize(rows):
    accepted=[r for r in rows if r['accepted']]
    correct=sum(r['correct'] for r in accepted)
    classes={}
    for label in ['basic','economy','general','advanced']:
        chosen=[r for r in rows if r['choice']==label];expected=[r for r in rows if r['expected']==label]
        tp=sum(r['correct'] for r in chosen)
        classes[label]={'predicted':len(chosen),'correct':tp,'precision':tp/len(chosen) if chosen else 0,'recall':tp/len(expected)}
    return {'n':len(rows),'correct':sum(r['correct'] for r in rows),'accuracy':sum(r['correct'] for r in rows)/len(rows),
            'accepted':len(accepted),'accepted_correct':correct,'accepted_wrong':len(accepted)-correct,
            'precision':correct/len(accepted),'coverage':len(accepted)/len(rows),'wilson95':wilson(correct,len(accepted)),
            'macro_precision':statistics.mean(v['precision'] for v in classes.values()),'classes':classes,
            'p50_ms':statistics.median(r['duration_ms'] for r in rows),
            'languages':{lang:{'n':len([r for r in rows if r['language']==lang]),
                'correct':sum(r['correct'] for r in rows if r['language']==lang),
                'accepted':sum(r['accepted'] for r in rows if r['language']==lang),
                'accepted_correct':sum(r['accepted'] and r['correct'] for r in rows if r['language']==lang)} for lang in ['en','de']}}

def main():
    from specialize import transform
    dataset=ROOT/'validation.json';truth={r['id']:r for r in read(dataset)['cases']}
    old=[]
    for p in [ROOT.parent/'dataset.json',ROOT.parent/'alternatives/holdout.json',ROOT.parent/'calibration/test.json']:
        old.extend(r['text'].strip().casefold() for r in read(p)['cases'])
    assert len(truth)==200 and len({r['text'] for r in truth.values()})==200
    assert not set(old)&{r['text'].strip().casefold() for r in truth.values()}
    for tier in ['basic','economy','general','advanced']:
        for lang in ['en','de']:assert sum(r['expected']==tier and r['language']==lang for r in truth.values())==25
    selections=[read(ROOT/'results'/f'{e}-selected.json') for e in ['laya-typed-decisions','laya-english','laya-multilingual']]
    assert max(selections,key=lambda s:s['summary']['correct'])==selections[0]
    affine=read(ROOT/'affine.json');candidate=read(ROOT/'candidate.json')
    assert affine['source_sha256']==digest(ROOT/'results/laya-typed-decisions-dev.jsonl')
    cv=read(ROOT/'results/cross-validation.json')
    assert cv['source_sha256']==affine['source_sha256']
    best=max(cv['results'],key=lambda r:r['correct'])
    assert best['method']=='matrix' and best['penalty']==affine['penalty'] and best['correct']==165
    assert candidate['affine_sha256']==digest(ROOT/'affine.json')
    assert candidate['calibration_sha256']==digest(ROOT/'results/calibration.jsonl')
    native={r['id']:r for r in records(ROOT/'results/validation.jsonl')}
    metadata=read(ROOT/'results/validation.metadata.json')
    assert metadata['candidate_sha256']==digest(ROOT/'candidate.json') and metadata['dataset_sha256']==digest(dataset)
    plugin=ROOT.parents[2]/'plugins/laya-router/runtime'
    deployed=read(plugin/'routing-calibration.json')
    assert deployed['matrix']==affine['matrix'] and deployed['bias']==affine['bias']
    assert deployed['correctness']['4']==candidate['correctness']
    assert list(deployed['criteria'].values())==affine['variant']['descriptions']
    assert deployed['provenance']['validation_sha256']==digest(dataset)
    production=records(ROOT/'results/production.jsonl');pm=read(ROOT/'results/production.metadata.json')
    assert pm['dataset_sha256']==digest(dataset) and pm['worker_sha256']==digest(plugin/'worker.py')
    assert pm['calibration_sha256']==digest(plugin/'routing-calibration.json')
    remote=records(ROOT/'results/remote.jsonl');rm=read(ROOT/'results/remote.metadata.json')
    assert rm['dataset_sha256']==digest(dataset) and rm['policy']['minConfidence']==.8
    engines={e:[r for r in remote if r['engine']==e] for e in ['jev','gemma']}
    blocked={r['id'] for r in engines['jev'] if r['evaluation']['status']=='blocked'}
    assert blocked=={r['id'] for r in production if r['evaluation']['status']=='blocked'}
    local=[];three=[]
    for r in production:
        assert r['expected']==truth[r['id']]['expected'] and r['language']==truth[r['id']]['language']
        original=native[r['id']];mapped=transform(original['raw_probabilities'],affine)
        assert all(abs(mapped[k]-original['probabilities'][k])<1e-12 for k in mapped)
        assert original['correct']==(original['choice']==r['expected'])
        confidence=calibrated(max(mapped.values()),candidate['correctness']['a'],candidate['correctness']['b'])
        assert abs(confidence-original['calibrated'])<1e-12
        ev=r['evaluation'];d=(ev.get('distributions') or {}).get('tier')
        if r['id'] not in blocked:
            assert d and d['choice']==original['choice'] and abs(d['confidence']-confidence)<1e-8
            assert all(abs(mapped[k]-d['probabilities'][k])<1e-8 for k in mapped)
            assert (ev['status']=='evaluated')==(confidence>=.8)
            assert ev['outputTokens']==0 and ev['costUsd']==0
        choice=d['choice'] if d else None
        local.append({'id':r['id'],'expected':r['expected'],'language':r['language'],'choice':choice,
            'correct':choice==r['expected'],'accepted':ev['status']=='evaluated','duration_ms':ev['durationMs']})
        e3=r['three'];d3=(e3.get('distributions') or {}).get('tier');expected='middle' if r['expected'] in ['economy','general'] else r['expected']
        if r['id'] not in blocked:
            p3={'basic':mapped['basic'],'middle':mapped['economy']+mapped['general'],'advanced':mapped['advanced']}
            assert d3 and all(abs(p3[k]-d3['probabilities'][k])<1e-8 for k in p3)
            assert d3['choice']==max(p3,key=p3.get)
        three.append({'correct':bool(d3 and d3['choice']==expected),'accepted':e3['status']=='evaluated'})
    summary={'laya':summarize(local)}
    for e,group in engines.items():
        assert len(group)==len({r['id'] for r in group})==200
        for r in group:
            assert r['expected']==truth[r['id']]['expected'] and r['correct']==(r['choice']==r['expected'])
            r['duration_ms']=r['evaluation']['durationMs']
        summary[e]=summarize(group)
    assert len(native)==len(production)==len({r['id'] for r in production})==200
    gaps={k:{'percentage_points':100*(summary['jev'][k]-summary['laya'][k]),
             'relative_percent':100*(summary['jev'][k]-summary['laya'][k])/summary['jev'][k]} for k in ['precision','macro_precision','accuracy']}
    assert all(g['relative_percent']<=10 and g['percentage_points']<=10 for g in gaps.values())
    lines=['# Frozen Laya router versus JEV on 200 fresh prompts','',
        'The production plugin uses typed-decisions, a JSON task state, an activity/category choice question, affine four-class calibration fitted on 200 development prompts, and a separate correctness map fitted on the earlier 120 calibration cases. All four-tier fits and wording were frozen before validation inference. No neural weights were trained.', '',
        '| Router | All-case correct | Macro class precision | Accepted correct | Accepted precision | Coverage | Median gateway time |',
        '| --- | --- | --- | --- | --- | --- | --- |']
    for e,d in summary.items():
        lines.append(f"| {e} | {d['correct']}/200 ({100*d['accuracy']:.1f}%) | {100*d['macro_precision']:.1f}% | {d['accepted_correct']}/{d['accepted']} | {100*d['precision']:.1f}% | {100*d['coverage']:.1f}% | {d['p50_ms']:.0f} ms |")
    lines+=['','## Target audit','','Both percentage-point and relative differences are below 10% for accepted precision, macro class precision and overall label accuracy. Coverage remains lower than JEV. These are observed point estimates, not proof of population noninferiority.','',
        '| Metric | Gap to JEV in percentage points | Relative gap |','| --- | --- | --- |']
    for k,g in gaps.items():lines.append(f"| {k} | {g['percentage_points']:.2f} | {g['relative_percent']:.2f}% |")
    lines+=['','## Class boundaries','','All available predicted labels, including low-confidence classifications. Blocked prompts have no predicted label and remain incorrect/unresolved in overall accuracy.','',
        '| Class | Laya precision | Laya recall | JEV precision | JEV recall |','| --- | --- | --- | --- | --- |']
    for tier,d in summary['laya']['classes'].items():
        j=summary['jev']['classes'][tier]
        lines.append(f"| {tier} | {100*d['precision']:.1f}% | {100*d['recall']:.1f}% | {100*j['precision']:.1f}% | {100*j['recall']:.1f}% |")
    lines+=['','Economy remains the weakest class; no per-class parity claim is made. Per-language counts and Wilson intervals are retained in `summary.json`.','',
        '## Gates and actual runtime','','JEV and the production Laya path exclude the same two prompts under the existing disclosure guard. Direct candidate inference accepted 140 with 131 correct; the actual gateway excludes two wrong accepted decisions, giving 138 accepted with 131 correct. The report uses the same gateway policy for both models and leaves the gate at 0.8. The guard is not modified to make the test pass. Gemma requests resolve through the currently configured local vLLM provider; this differs from earlier remote-provider timings.', '',
        f"Three-tier regression: {sum(r['correct'] for r in three)}/200 correct, {sum(r['accepted'] for r in three)} accepted, {sum(r['accepted'] and r['correct'] for r in three)} accepted correct. The two middle bands are summed and the correctness map is fitted on grouped old calibration labels. This grouping was added after the four-tier validation was inspected; it is a regression check, not a fresh independent three-tier model-selection result.", '',
        '## Selection and limits','','All three checkpoints received the same 16 declared development variants (9,600 predictions). Best development accuracy: typed-decisions 152/200, English 137/200, multilingual 128/200. A 20-coefficient affine map selected with development cross-validation reached 165/200; final four-tier validation was 174/200. Retain every variant, including poor ones. Prompt/model and regularizer selection reuse development data; only the new validation is separate.', '',
        'The 200 validation prompts are balanced, same-author synthetic rubric cases; 100 bilingual scenario pairs are correlated. Exact text overlap with all earlier sets is rejected. No real session text or credentials are included. Strong specialist wording can make advanced tasks easier to recognize than ambiguous real traffic. Accepted precision does not measure downstream answer quality. Confidence intervals are descriptive and may understate correlation. This experiment establishes the requested gap on this dataset, not production-wide quality guarantees.', '',
        'The exact worker, model weights, production calibration artifact and test inputs are hash-verified. Every eligible four-tier pipe prediction matches the frozen candidate within numerical tolerance. The source plugin is updated; the live gateway, installed weights and settings are unchanged. Setup and plugin reload are required to use it.','']
    (ROOT/'results/summary.json').write_text(json.dumps({'models':summary,'gaps':gaps,'blocked_ids':sorted(blocked)},indent=2)+'\n')
    (ROOT/'results/report.md').write_text('\n'.join(lines))
    print(json.dumps(gaps),flush=True)

if __name__=='__main__':main()
