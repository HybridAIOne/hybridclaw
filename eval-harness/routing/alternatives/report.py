"""Summarize frozen-development selections and held-out routing decisions."""
import importlib.util
import json
from pathlib import Path

root=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('routing_eval',root/'run.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
folder=root/'results'
engines=['jeff','gliclass','horizon','laya-english','laya-typed-decisions','laya-multilingual']
lines=['# Small local routing models — 2026-09-29', '',
       'Development: the existing 200 prompts. Holdout: 120 newly authored prompts, balanced across four tiers and English/German. '
       'All selections were fixed using development results before held-out inference. These are authored rubric labels, not measured ability of downstream execution models.', '',
       'Horizon matches the best Laya checkpoint on this holdout, but neither accepts a decision at the unchanged 0.8 gate. '
       'GLiClass accepts 34/120 with zero observed errors (16 basic, 3 general, 15 advanced); it is a candidate for further selective-routing validation, not a replacement proven superior to JEV. '
       'JEV and Gemma remain substantially stronger overall. No live model is changed.', '',
       '## Selected development variants', '',
       '| Model | Variant | Correct /200 | Accepted at 0.8 | Wrong accepted |',
       '| --- | --- | --- | --- | --- |']
for e in engines[:3]:
    d=json.loads((folder/f'{e}-selected.json').read_text());s=d['summary']
    lines.append(f"| {e} | {d['variant']['name']} | {s['correct']} | {s['accepted']} | {s['accepted_wrong']} |")
for e,dirname,var in [('laya-english','laya-english-2026-09-29','choice-json-capability'),('laya-typed-decisions','laya-typed-decisions-2026-09-29','choice-json-capability'),('laya-multilingual','laya-variations-2026-09-29','choice-json-difficulty')]:
    s=next(x for x in json.loads((root.parent/'results'/dirname/'summary.json').read_text()) if x['variant']==var)
    lines.append(f"| {e} | {var} | {s['correct']} | {s['accepted']} | {s['accepted']-s['accepted_correct']} |")
lines+=['', 'Six variants were tested for each new model. Laya selections come from the earlier 20-variant experiments; the search budgets differ. '
        'The first variant in declared order wins development accuracy ties. No confidence thresholds or temperatures were fitted.', '',
        '## Fresh holdout', '',
        '| Model | Correct /120 | EN /60 | DE /60 | Accepted | Wrong accepted | p50 / p95 ms |',
        '| --- | --- | --- | --- | --- | --- | --- |']
allrows={}
holdout=json.loads((root/'holdout.json').read_text())['cases']
truth={c['id']:c for c in holdout}
for e in engines:
    rows=[json.loads(line) for line in (folder/f'{e}-test.jsonl').read_text().splitlines()]
    assert len(rows)==len({r['id'] for r in rows})==120
    assert {r['id'] for r in rows}==set(truth)
    metadata=json.loads((folder/f'{e}-test.metadata.json').read_text())
    assert metadata['dataset_sha256']==module.digest(root/'holdout.json')
    if not e.startswith('laya-'):
        assert metadata['variants']==[json.loads((folder/f'{e}-selected.json').read_text())['variant']]
    for r in rows:
        assert (r['expected'],r['language'])==(truth[r['id']]['expected'],truth[r['id']]['language'])
        assert r['correct']==(r.get('choice')==r['expected'])
    allrows[e]=rows;s=module.summarize(rows)
    lines.append(f"| {e} | {s['correct']} ({s['correct']/1.2:.1f}%) | {s['languages']['en']['correct']} | {s['languages']['de']['correct']} | {s['accepted']} | {s['accepted_wrong']} | {s['p50_ms']:.0f} / {s['p95_ms']:.0f} |")
remote=folder/'remote.jsonl'
if remote.exists():
    records=[json.loads(l) for l in remote.read_text().splitlines()]
    for engine in ['jev','gemma']:
        rs=[r for r in records if r['engine']==engine];assert len(rs)==120
        durations=sorted(r['evaluation']['durationMs'] for r in rs)
        accepted=[r for r in rs if r['accepted']]
        lines.append(f"| {engine} (API reference) | {sum(r['correct'] for r in rs)} ({sum(r['correct'] for r in rs)/1.2:.1f}%) | {sum(r['correct'] and r['language']=='en' for r in rs)} | {sum(r['correct'] and r['language']=='de' for r in rs)} | {len(accepted)} | {sum(not r['correct'] for r in accepted)} | {(durations[59]+durations[60])/2:.0f} / {durations[113]:.0f} |")
lines+=['', 'Accepted means selected probability ≥0.8 for local models. JEV/Gemma references use the production gate/status; '
        'Gemma is a label-only classifier, so its acceptance is not confidence-calibrated. '
        'Zero accepted errors with very few accepted decisions is not evidence of zero risk. '
        'All wrong predictions count against accuracy even when rejected.', '',
        '## Local error direction and calibration', '',
        '| Model | Under-tier | Over-tier | Invalid | Brier ↓ |',
        '| --- | --- | --- | --- | --- |']
tiers=['basic','economy','general','advanced']
for e,rs in allrows.items():
    good=[r for r in rs if r.get('probabilities')]
    under=sum(tiers.index(r['choice'])<tiers.index(r['expected']) for r in good)
    over=sum(tiers.index(r['choice'])>tiers.index(r['expected']) for r in good)
    brier=sum(sum((p-(k==r['expected']))**2 for k,p in r['probabilities'].items()) for r in good)/len(good)
    lines.append(f'| {e} | {under} | {over} | {120-len(good)} | {brier:.3f} |')
lines+=['', '## Runtime and interpretation limits', '',
        'The initial GLiClass run inherited BF16 and produced 39/1,200 distributions outside the sum tolerance. CPU diagnostics reproduced the rounding. '
        'The full development sweep was rerun in explicit FP32 before selection; all 1,200 FP32 distributions were valid. '
        'The BF16 records are preserved under `gliclass-bf16-diagnostic/` and excluded from the final selection.', '',
        'The new classifiers use PyTorch MPS on Apple silicon; Laya uses MLX FP16. '
        'Reported local latency includes tokenization and device synchronization, excludes loading and one development warmup, and uses one request at a time. '
        'CPU/GPU runtime and precision differ across families; API timings include network and gateway classifier handling.', '',
        'jeff preserves its upstream normalized sigmoid scores and temperature 3.2; GLiClass uses single-label softmax; '
        'Horizon uses exclusive NLI entailment scores normalized across the four candidates. These distributions are not equivalently calibrated. '
        'No model was fine-tuned, no threshold lowered, and no live settings changed.', '',
        'The same author and tier rubric were used for development and holdout. '
        'Prompts are short, self-contained text, with no attachments or history; language and class balance do not match production prevalence. '
        'Passing this holdout does not establish attachment handling, production accuracy or downstream task success. '
        'Fresh independent traffic and threshold calibration would be required before deployment.', '',
        'See [protocol](../PROTOCOL.md), [reproduction](../README.md), per-call JSONL and pinned model/runtime metadata alongside this report.', '']
(folder/'report.md').write_text('\n'.join(lines))
