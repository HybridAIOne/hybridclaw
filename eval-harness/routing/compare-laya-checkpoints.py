"""Compare saved checkpoint ablations under matching datasets and question variants.
This summarizes evidence only; choosing a winner here is exploratory model selection.
"""
import json
from pathlib import Path

root = Path(__file__).parent / 'results'
runs = {
    'Multilingual 322M': 'laya-variations-2026-09-29',
    'English 421M': 'laya-english-2026-09-29',
    'Typed-decisions 421M': 'laya-typed-decisions-2026-09-29',
}
data = {}
designs = {}
for name, directory in runs.items():
    designs[name] = json.loads((root / directory / 'design.json').read_text())
    data[name] = json.loads((root / directory / 'summary.json').read_text())
reference = next(iter(designs.values()))
for design in designs.values():
    assert design['dataset_sha256'] == reference['dataset_sha256']
    assert design['variants'] == reference['variants']
    assert design['threshold'] == reference['threshold']


def cell(s):
    precision = f"{100*s['accepted_correct']/s['accepted']:.1f}%" if s['accepted'] else '—'
    return f"{s['correct']}/200 ({s['correct']/2:.1f}%) | {s['en']}% | {s['de']}% | {s['accepted']}/200 | {precision}"


lines = ['# Three Laya checkpoints: matched routing evaluation', '',
         'Same 200 authored prompts, 20 predeclared variants per checkpoint, FP16 MLX, and 80% selected-probability gate. '
         '12,000 predictions in total: the existing 4,000 multilingual results plus 8,000 new English/typed-decisions predictions. '
         'No cloud inference, no live router changes. Checkpoint downloads were revision-pinned and weight hashes verified.', '',
         'The dataset and variant definitions are identical across runs. This is reuse of an inspected dataset, '
         'not fresh validation. Checkpoint-specific temperatures remain unchanged; acceptance rates are not equivalently calibrated risk guarantees.', '',
         '## Matched choice question: How difficult is this task?', '',
         '| Checkpoint / state | Correct | EN /100 | DE /100 | Accepted | Correct among accepted |',
         '|---|---:|---:|---:|---:|---:|']
for name, summaries in data.items():
    for state in ['raw', 'json']:
        s = next(r for r in summaries if r['variant'] == f'choice-{state}-difficulty')
        lines.append(f'| {name} / {state} | {cell(s)} |')
lines += ['', '## Best observed variant per type', '',
          'Each maximum is selected on this same dataset. It is optimistic selection evidence, not a held-out accuracy claim.', '',
          '| Checkpoint | Type | Variant | Correct | EN /100 | DE /100 | Accepted | Correct among accepted |',
          '|---|---|---|---:|---:|---:|---:|---:|']
for name, summaries in data.items():
    for kind in ['choice', 'score']:
        s = max((r for r in summaries if r['variant'].startswith(kind+'-')),key=lambda r:r['correct'])
        lines.append(f"| {name} | {kind} | {s['variant']} | {cell(s)} |")
lines += ['', '## All matched variants', '',
          '| Variant | Multilingual /200 | English /200 | Typed decisions /200 |', '|---|---:|---:|---:|']
for variant in reference['variants']:
    scores=[str(next(r['correct'] for r in summaries if r['variant']==variant['name'])) for summaries in data.values()]
    lines.append(f"| {variant['name']} | {' | '.join(scores)} |")
lines += ['', '## Provenance and limits', '']
for name, directory in runs.items():
    design=designs[name]
    lines.append(f"- {name}: `{design['checkpoint']}`; [design]({directory}/design.json), [report]({directory}/report.md), [per-call results]({directory}/results.jsonl).")
lines += ['', '- Raw choice and JSON choice are controlled comparisons. Score uses modal level; rounded expected-score diagnostics are in the per-checkpoint reports.',
          '- Models are MLX conversions of the three upstream checkpoints. Port fidelity is not validated against PyTorch in this experiment.',
          '- English and typed-decisions are English-oriented; the German subset intentionally measures language transfer.',
          '- Direct inference latency excludes loading and differs from the earlier gateway timing. Checkpoints were run sequentially, not concurrently.',
          '- Equal tier counts, partly paired bilingual cases and authored rubric labels limit generalization to real traffic and downstream model capability.',
          '- Choosing a new checkpoint, state format or question requires fresh validation; no temperature or threshold tuning was performed.', '']
(root / 'laya-checkpoints-report.md').write_text('\n'.join(lines))
print('\n'.join(lines[:21]))
