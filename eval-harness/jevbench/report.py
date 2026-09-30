"""Render public aggregate JevBench exports without reading per-item evidence."""
import json
from pathlib import Path
import sys

folder = Path(sys.argv[1])
engines = ['jev', 'gemma', 'laya-english', 'laya-typed-decisions', 'laya-multilingual']
summaries = {e: json.loads((folder / f'{e}-summary.json').read_text()) for e in engines}

def percent(value):
    return f'{100 * value:.1f}%'

def accuracy(metric):
    return f"{metric['n_correct']}/{metric['n_planned']} ({percent(metric['accuracy'])})"

lines = [
    '# JevBench public subset — 2026-09-29', '',
    '231 public cases per engine: easy 48, original 72, hard 111. '
    'This is not the official leaderboard composite: its sealed/private and imported cohorts are unavailable. '
    'All five engines receive the same canonical state and typed question. No routing tier prompt, confidence gate, retry or fallback is applied.', '',
    '| Engine | Correct | Easy | Original | Hard | p50 / p95 | Valid |',
    '| --- | --- | --- | --- | --- | --- | --- |',
]
for engine, d in summaries.items():
    assert d['complete'] and d['n_attempted'] == 231
    lat = d['latency']
    lines.append(f"| {engine} | {accuracy(d)} | " + ' | '.join(percent(d['cohorts'][c]['accuracy']) for c in ['easy','original','hard']) + f" | {lat['p50_s']*1000:.0f} / {lat['p95_s']*1000:.0f} ms | {d['n_valid']}/231 |")
lines += ['', '## Typed questions', '',
          '| Engine | choice (139) | noul / boolean (74) | score / ordinal (18) |',
          '| --- | --- | --- | --- |']
for engine, d in summaries.items():
    lines.append(f'| {engine} | ' + ' | '.join(accuracy(d['question_types'][t]) for t in ['choice','noul','score']) + ' |')
lines += ['', 'Ordinal accuracy uses upstream argmax, not rounded expected score. '
          'Eighteen ordinal cases are too few to establish a general advantage.', '',
          '## Confidence and context', '',
          '| Engine | Probability source | Brier ↓ | ECE ↓ | State truncated |',
          '| --- | --- | --- | --- | --- |']
for engine, d in summaries.items():
    trunc = str(d['state_truncated_count']) if engine.startswith('laya') else 'not measured'
    lines.append(f"| {engine} | {', '.join(d['probability_sources'])} | {d['brier_mean']:.3f} | {d['ece']['ece']:.3f} | {trunc} |")
lines += ['', 'On each checkpoint’s own subset with untruncated state:', '']
for engine, d in summaries.items():
    if engine.startswith('laya'):
        u = d['untruncated_state']
        lines.append(f"- {engine}: {u['correct']}/{u['n']} ({100*u['correct']/u['n']:.1f}%).")
lines += ['', 'These subsets differ by tokenizer and context limit; they are not a controlled comparison.']
lines += ['', 'Brier and ECE use valid probability distributions only; invalid answers still count as incorrect in accuracy. '
          'Gemma probabilities are verbalized JSON values, not token logits or a calibrated confidence guarantee.', '',
          'Laya uses native `choice`, `noul` and `score` through `laya-mlx==0.2.0` in FP16. '
          'English has a 512-token total budget; typed-decisions and multilingual have 1,024. '
          'These runs retain upstream truncation, including question/option limits. '
          'The production router rejects oversized inputs instead. '
          'English and typed-decisions also retain the runtime’s temperature clamp for the shipped `choice:11+` bucket '
          '(0.1006 becomes 0.5), but none of these public cases uses 11 or more options, so this clamp does not affect these results.', '',
          '## Interpretation', '',
          'This tests general typed decisions, not selection of a model tier. '
          'It confirms that using native typed questions alone does not close Laya’s quality gap on these cases. '
          'The checkpoint ordering differs from our routing prompt experiments, so choose using the intended workload. '
          'Retain JEV/Gemma as the quality baselines; these results do not justify promoting Laya as the default router.', '',
          '## Reproduction and limits', '',
          'See [runner instructions](../../README.md). Source revision and dataset hashes, model/checkpoint identities, '
          'weight hashes, configuration and complete aggregate metrics accompany this report. '
          'Raw requests/responses and per-item decisions remain outside the repository. '
          'No provider tariff was supplied, so cost is unknown rather than zero; ledger reservations are not bills. '
          'Latency is client-observed, serial within each engine, with remote engines running alongside one local model at a time. '
          'Local weight loading is excluded; tokenization and truncation diagnostics are included. '
          'Public cases may overlap training data; this is a single run without a held-out generalization claim.', '',
          'Source: [fstandhartinger/jevbench](https://github.com/fstandhartinger/jevbench/tree/bb05a335bc809e61b20c0f745d25499a82b326fc).', '']
(folder / 'report.md').write_text('\n'.join(lines))
