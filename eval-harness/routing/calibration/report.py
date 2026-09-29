"""Validate immutable test evidence and summarize calibration and gate errors."""
import hashlib
import json
import math
from pathlib import Path
from calibrate import ENGINES, calibrated, logit

ROOT=Path(__file__).resolve().parent

def wilson(correct,n):
    if not n:return None
    z=1.959963984540054;p=correct/n;den=1+z*z/n
    mid=(p+z*z/(2*n))/den;delta=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return [mid-delta,mid+delta]

def stats(rows,key):
    n=len(rows)
    scores=[r[key] for r in rows];truth=[int(r['correct']) for r in rows]
    ece=0
    for i in range(10):
        group=[(p,y) for p,y in zip(scores,truth) if i/10<=p<(i+1)/10 or i==9 and p==1]
        if group:ece+=abs(sum(p-y for p,y in group))/n
    return {'n':n,'accuracy':sum(truth)/n,'mean_confidence':sum(scores)/n,'brier':sum((p-y)**2 for p,y in zip(scores,truth))/n,
            'nll':-sum(math.log(max(1e-12,p if y else 1-p)) for p,y in zip(scores,truth))/n,'ece_10_bins':ece}

def gate(rows,key,threshold):
    accepted=[r for r in rows if r[key]>=threshold];correct=sum(r['correct'] for r in accepted)
    return {'accepted':len(accepted),'correct':correct,'wrong':len(accepted)-correct,'accuracy':correct/len(accepted) if accepted else None,'wilson95':wilson(correct,len(accepted))}

def main():
    frozen=ROOT/'frozen.json';test=ROOT/'test.json';fits=json.loads(frozen.read_text())['models']
    truth={r['id']:r for r in json.loads(test.read_text())['cases']}
    summary={};lines=['# Laya calibration on fresh test prompts — 2026-09-29','',
    'Fit each checkpoint on the previously inspected 120-prompt holdout, then freeze the maps before creating and evaluating this new 120-prompt English/German test. '
    'Model weights, choice variants and tier predictions stay unchanged. No thresholds were selected using this test.', '',
    '## Primary acceptance gate: 0.8', '',
    '| Checkpoint | Overall correct | Raw accepted (wrong) | Calibrated accepted (wrong) | Calibrated accepted accuracy | Nominal 95% interval |',
    '| --- | --- | --- | --- | --- | --- |']
    for engine in ENGINES:
        path=ROOT/'results'/f'{engine}.jsonl';rows=[json.loads(l) for l in path.read_text().splitlines()]
        metadata=json.loads(path.with_suffix('.metadata.json').read_text())
        assert metadata['frozen_sha256']==hashlib.sha256(frozen.read_bytes()).hexdigest()
        assert metadata['test_sha256']==hashlib.sha256(test.read_bytes()).hexdigest()
        assert len(rows)==len({r['id'] for r in rows})==len(truth)==120
        for r in rows:
            assert r['expected']==truth[r['id']]['expected'] and r['language']==truth[r['id']]['language']
            assert r['choice']==max(r['probabilities'],key=r['probabilities'].get)
            assert r['correct']==(r['choice']==r['expected'])
            assert abs(r['calibrated']-calibrated(r['raw'],fits[engine]['a'],fits[engine]['b']))<1e-12
        d={'raw':stats(rows,'raw'),'calibrated':stats(rows,'calibrated'),'gates':{},'languages':{}}
        for threshold in [.8,.95]:d['gates'][str(threshold)]={k:gate(rows,k,threshold) for k in ['raw','calibrated']}
        for lang in ['en','de']:
            group=[r for r in rows if r['language']==lang]
            d['languages'][lang]={k:{'stats':stats(group,k),'gate_08':gate(group,k,.8)} for k in ['raw','calibrated']}
        summary[engine]=d
        raw=d['gates']['0.8']['raw'];cal=d['gates']['0.8']['calibrated'];ci=cal['wilson95']
        interval=f'{100*ci[0]:.1f}–{100*ci[1]:.1f}%' if ci else '—'
        accuracy=f"{100*cal['accuracy']:.1f}%" if cal['accuracy'] is not None else '—'
        lines.append(f"| {engine} | {sum(r['correct'] for r in rows)}/120 | {raw['accepted']} ({raw['wrong']}) | {cal['accepted']} ({cal['wrong']}) | {accuracy} | {interval} |")
    lines+=['','## Confidence quality on all test predictions','','Binary correctness metrics, not the multiclass Brier score used in earlier reports. Lower is better. ECE uses ten fixed equal-width bins and is noisy on this small sample.','',
            '| Checkpoint | Mean raw → calibrated confidence | Accuracy | Brier raw → calibrated | NLL raw → calibrated | ECE raw → calibrated |',
            '| --- | --- | --- | --- | --- | --- |']
    for e,d in summary.items():
        a,b=d['raw'],d['calibrated']
        lines.append(f"| {e} | {100*a['mean_confidence']:.1f}% → {100*b['mean_confidence']:.1f}% | {100*a['accuracy']:.1f}% | {a['brier']:.3f} → {b['brier']:.3f} | {a['nll']:.3f} → {b['nll']:.3f} | {a['ece_10_bins']:.3f} → {b['ece_10_bins']:.3f} |")
    lines+=['','## Fixed conservative gate: 0.95','','| Checkpoint | Accepted | Wrong | Accepted accuracy |','| --- | --- | --- | --- |']
    for e,d in summary.items():
        g=d['gates']['0.95']['calibrated'];accuracy=f"{100*g['accuracy']:.1f}%" if g['accuracy'] is not None else '—'
        lines.append(f"| {e} | {g['accepted']} | {g['wrong']} | {accuracy} |")
    lines+=['','## Frozen maps and equivalent raw cutoffs','','| Checkpoint | a | b | Raw cutoff for calibrated 0.8 | Raw cutoff for calibrated 0.95 |','| --- | --- | --- | --- | --- |']
    for e,c in fits.items():
        cutoffs=[1/(1+math.exp(-(logit(t)-c['b'])/c['a'])) for t in [.8,.95]]
        lines.append(f"| {e} | {c['a']:.4f} | {c['b']:.4f} | {cutoffs[0]:.4f} | {cutoffs[1]:.4f} |")
    lines+=['','The monotone map changes the meaning of confidence and which decisions pass a gate; it cannot fix incorrect tier choices or improve their ranking. '
            'It estimates correctness of the winning tier, not a four-class probability distribution. The equivalent raw cutoffs make the increased/decreased acceptance explicit.', '',
            '## Limits and deployment', '',
            'Both sets are small, balanced, same-author synthetic rubric data. Some English/German cases share scenarios, so the per-prompt Wilson intervals are descriptive and may understate uncertainty from correlation. '
            'Coverage and accuracy need validation on independent real traffic, particularly attachments, history and ambiguous tier boundaries. '
            'A calibrated score of 0.95 is not a guaranteed 95% success rate; the secondary gate was fixed before testing and is not a recommended production threshold.', '',
            'No live model, confidence policy, weights or gateway process was changed. See [protocol](../PROTOCOL.md) and [reproduction](../README.md). Per-language metrics are in `summary.json`.','']
    (ROOT/'results/summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    (ROOT/'results/report.md').write_text('\n'.join(lines))

if __name__=='__main__':main()
