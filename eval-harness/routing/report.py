"""Summarize saved classifier evidence without querying models or inventing confidence.
Raw classification and configured-default fallback are reported separately.
"""
import collections
import json
import math
from pathlib import Path
import sys

root = Path(sys.argv[1])
rows = [json.loads(line) for line in (root / 'results.jsonl').read_text().splitlines()]
meta = json.loads((root / 'metadata.json').read_text())
tiers = list(meta['criteria'])
engines = list(meta['models'])


def fraction(n, d):
    return f'{n}/{d} ({100*n/d:.1f}%)' if d else '—'


def percentile(values, p):
    return sorted(values)[max(0, math.ceil(len(values)*p)-1)]


lines = [f"# Routing comparison: {meta['count']} synthetic prompts", '',
         f"Run: {meta['startedAt']} · Source commit: `{meta['commit'][:12]}`", '',
         'Balanced rubric benchmark: 50 cases per tier, 100 English and 100 German. '
         'Labels were authored before inference. Prompts are synthetic and inspired only by aggregate session themes; '
         'no historical message text was submitted. This measures adherence to the routing rubric, not downstream answer quality.', '',
         f"Production timeout: {meta['timeoutMs']} ms. Typed-router threshold: {meta['minConfidence']:.0%}. "
         f"Rejected or failed decisions use the configured `{meta['defaultStart']}` tier. No retries. "
         'Gemma produces a tier without a probability, so every valid Gemma answer is accepted. '
         'JEV uses its reported confidence; Laya uses selected-option probability. Those scores are not directly comparable.', '',
         '| Router | Raw correct / all | Valid decisions | Accepted | Correct among accepted | Correct after default fallback | p50 / p95 latency |',
         '|---|---:|---:|---:|---:|---:|---:|']
summary = {}
for engine in engines:
    group = [r for r in rows if r['engine'] == engine]
    n = len(group)
    valid = [r for r in group if r['choice'] in tiers]
    accepted = [r for r in group if r['accepted']]
    correct = sum(r['choice'] == r['expected'] for r in group)
    accepted_correct = sum(r['choice'] == r['expected'] for r in accepted)
    effective_correct = sum(r['effectiveTier'] == r['expected'] for r in group)
    times = [r['evaluation']['durationMs'] for r in group]
    summary[engine] = dict(total=n, valid=len(valid), correct=correct, accepted=len(accepted),
                           accepted_correct=accepted_correct, effective_correct=effective_correct,
                           p50_ms=percentile(times,.5), p95_ms=percentile(times,.95),
                           failures=n-len(valid), reasons=dict(collections.Counter(r['evaluation']['reason'] for r in group)))
    s = summary[engine]
    lines.append(f"| {engine} | {fraction(correct,n)} | {len(valid)}/{n} | {fraction(len(accepted),n)} | {fraction(accepted_correct,len(accepted))} | {fraction(effective_correct,n)} | {s['p50_ms']} / {s['p95_ms']} ms |")
lines += ['', 'Latency includes the production classifier wrapper and remote round trip; Laya model startup is excluded, '
          'but first inference is included. Default-fallback outcomes simulate tiers before model selection or manual escalation. Calls run concurrently across the three engines and sequentially within each engine. '
          'Prompts run in dataset order, so tier and run order are confounded. Gemma resolves through the configured provider endpoint.', '',
          '## Accuracy by language and tier', '',
          '| Slice | JEV | Laya | Gemma |', '|---|---:|---:|---:|']
for key, value in [('language','en'),('language','de')]+[('expected',t) for t in tiers]:
    cells=[]
    for engine in engines:
        g=[r for r in rows if r['engine']==engine and r[key]==value]
        cells.append(fraction(sum(r['choice']==r['expected'] for r in g),len(g)))
    lines.append(f"| {value} | {' | '.join(cells)} |")
lines += ['', '## Post-hoc fallback replay', '',
          'These are simulations over saved predictions, not additional live runs. '
          'They replace the configured Basic fallback with Gemma when the primary abstains or fails. '
          'Serial latency was not measured; selecting a policy on this dataset requires fresh validation.', '',
          '| Primary → fallback | Correct | Gemma calls needed |', '|---|---:|---:|']
by_case = collections.defaultdict(dict)
for row in rows:
    by_case[row['id']][row['engine']] = row
for primary in ['jev', 'laya']:
    replay = [(group[primary] if group[primary]['accepted'] else group['gemma']) for group in by_case.values()]
    lines.append(f"| {primary} → gemma | {fraction(sum(r['choice']==r['expected'] for r in replay),len(replay))} | {sum(not group[primary]['accepted'] for group in by_case.values())}/{len(replay)} |")
lines += ['', '## Confusion matrices', '', 'Rows are expected tiers; columns are raw predictions. Rejected low-confidence predictions remain visible.']
for engine in engines:
    lines += ['', f'### {engine}', '', '| Expected | '+' | '.join(tiers)+' | No valid choice |', '|---|'+'---:|'*5]
    for tier in tiers:
        counts=collections.Counter(r['choice'] if r['choice'] in tiers else 'missing' for r in rows if r['engine']==engine and r['expected']==tier)
        lines.append('| '+tier+' | '+' | '.join(str(counts[t]) for t in tiers+['missing'])+' |')
lines += ['', '## Tokens and estimated cost', '', '| Router | Input tokens | Output tokens | Reported/estimated cost |', '|---|---:|---:|---:|']
for engine in engines:
    es=[r['evaluation'] for r in rows if r['engine']==engine]
    def total(key):
        vals=[e[key] for e in es if e[key] is not None]
        return f'{sum(vals):,}'+(' (partial)' if len(vals)!=len(es) else '') if vals else 'Unavailable'
    costs=[e['costUsd'] for e in es if e['costUsd'] is not None]
    cost=f'${sum(costs):.6f}'+(' (partial)' if len(costs)!=len(es) else '') if costs else 'Unavailable'
    lines.append(f"| {engine} | {total('inputTokens')} | {total('outputTokens')} | {cost} |")
lines += ['', 'Local zero cost means no API fee; hardware and electricity are excluded. Missing cost is not zero.', '',
          '## Misclassifications and failures', '', '| Case | Language | Expected | Router | Raw choice | Confidence | Accepted |', '|---|---|---|---|---|---:|---|']
for r in rows:
    if r['choice'] != r['expected']:
        conf='—' if r['confidence'] is None else f"{r['confidence']:.1%}"
        lines.append(f"| {r['id']} | {r['language']} | {r['expected']} | {r['engine']} | {r['choice'] or 'No valid choice'} | {conf} | {'Yes' if r['accepted'] else 'No'} |")
lines += ['', '## Interpretation limits', '',
          '- These labels encode the authored four-tier rubric, not experimentally measured minimum model capability.',
          '- Equal tier counts are a stress-test design, not the observed frequency of actual user tasks.',
          '- Advanced cases emphasize specialist reasoning and proofs; some English/German cases are semantic counterparts. Cases are not independent random samples of traffic.',
          '- No prompt tuning or threshold changes were made using this dataset. The dataset becomes regression material after this run.',
          '- One run per case; network load, provider changes and calibration may affect results. No calibrated correctness claim follows from model confidence.',
          '- Current-message-only classification: no conversation history, attachments or actual downstream task execution.',
          '', f"Dataset SHA-256: `{meta['datasetSha256']}`", '']
(root / 'report.md').write_text('\n'.join(lines))
(root / 'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
