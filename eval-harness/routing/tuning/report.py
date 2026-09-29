"""Audit frozen inputs and compare identical production routing evaluations.
Historical development sets cannot become fresh evidence by renaming them.
"""
import hashlib
import json
import math
from pathlib import Path
import statistics

from export import artifact

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT/'results'
LABELS = ['basic', 'economy', 'general', 'advanced']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(name):
    return [json.loads(line) for line in (RESULTS/name).read_text().splitlines()]


def metrics(rows, labels=LABELS):
    accepted = [r for r in rows if r['accepted']]
    correct = sum(r['choice'] == r['expected'] for r in rows)
    selected_correct = sum(r['choice'] == r['expected'] for r in accepted)
    return {'n': len(rows), 'correct': correct, 'accuracy': correct/len(rows),
            'accepted': len(accepted), 'accepted_correct': selected_correct,
            'precision': selected_correct/len(accepted), 'coverage': len(accepted)/len(rows),
            'median_ms': statistics.median(r.get('duration_ms', r['evaluation']['durationMs']) for r in rows),
            'per_class': {label: {'correct': sum(r['choice'] == label and r['expected'] == label for r in rows),
                                 'predicted': sum(r['choice'] == label for r in rows),
                                 'expected': sum(r['expected'] == label for r in rows)} for label in labels},
            'per_language': {lang: metrics_language(rows, lang) for lang in ['en', 'de']}}


def metrics_language(rows, language):
    subset = [r for r in rows if r['language'] == language]
    selected = [r for r in subset if r['accepted']]
    return {'n': len(subset), 'correct': sum(r['choice'] == r['expected'] for r in subset),
            'accepted': len(selected), 'accepted_correct': sum(r['choice'] == r['expected'] for r in selected)}


def production_rows(name):
    rows = []
    for r in load(name):
        e = r['evaluation']; distribution = (e.get('distributions') or {}).get('tier', {})
        rows.append({**r, 'choice': distribution.get('choice'),
                     'confidence': distribution.get('confidence'),
                     'accepted': e['status'] == 'evaluated' and e['recommendedTier'] is not None,
                     'duration_ms': e['durationMs']})
    return rows


def calibration_metrics(rows, temperature):
    def summarize(records):
        bins = []
        for i in range(10):
            subset = [r for r in records if i/10 <= r['confidence'] < (i+1)/10 or i == 9 and r['confidence'] == 1]
            if subset:
                bins.append({'n': len(subset), 'confidence': statistics.mean(r['confidence'] for r in subset),
                             'accuracy': statistics.mean(r['correct'] for r in subset)})
        return {'ece_10_equal_width': sum(b['n']*abs(b['confidence']-b['accuracy']) for b in bins)/len(records),
                'selected_correctness_brier': statistics.mean((r['confidence']-r['correct'])**2 for r in records),
                'mean_confidence': statistics.mean(r['confidence'] for r in records),
                'accepted_at_0_8': sum(r['confidence'] >= .8 for r in records), 'bins': bins}
    uncalibrated = []
    for row in rows:
        p = [row['probabilities'][k]**temperature for k in LABELS]
        uncalibrated.append({**row, 'confidence': max(p)/sum(p)})
    return {'before_temperature': summarize(uncalibrated), 'after_temperature': summarize(rows)}


def main():
    candidate = json.loads((ROOT/'candidate.json').read_text())
    development = json.loads((RESULTS/'development.json').read_text())
    selected = min(development, key=lambda r: (-r['selected']['correct'], r['selected']['nll']))
    assert selected['engine'] == 'multilingual' and selected['selected'] == candidate['selected']
    for engine in development:
        cv = load(f"laya-{engine['engine']}-cv.jsonl")
        assert len(cv) == 12*520
        for result in engine['development_cv']:
            subset = [r for r in cv if r['representation'] == result['representation'] and r['penalty'] == result['penalty']]
            assert len(subset) == 520 and len({(r['source'], r['id']) for r in subset}) == 520
            assert sum(r['choice'] == r['expected'] for r in subset) == result['correct']
            assert all(r['fold'] == int(r['group'].rsplit(':', 1)[1]) % 5 for r in subset)
    dataset = json.loads((ROOT/'test.json').read_text()); cases = dataset['cases']
    assert dataset['candidate_sha256'] == digest(ROOT/'candidate.json')
    assert len(cases) == 200 and len({r['scenario'] for r in cases}) == 100
    installed = ROOT.parents[2]/'plugins/laya-router/runtime/routing-calibration.json'
    assert json.loads(installed.read_text()) == artifact()
    meta = json.loads((RESULTS/'production-final.metadata.json').read_text())
    assert meta['calibration_sha256'] == digest(installed)
    assert meta['worker_sha256'] == digest(installed.parent/'worker.py')
    assert meta['dataset_sha256'] == digest(ROOT/'test.json')
    frozen = load('candidate.jsonl'); by_id = {r['id']: r for r in frozen}
    final = production_rows('production-final.jsonl')
    baseline = production_rows('baseline.jsonl'); remote = load('remote.jsonl')
    expected = {r['id']: r for r in cases}
    for group in [final, baseline, *[[r for r in remote if r['engine'] == e] for e in ['jev', 'gemma']]]:
        assert {r['id'] for r in group} == set(expected) and len(group) == 200
        assert all(r['expected'] == expected[r['id']]['expected'] for r in group)
    for row in final:
        e = row['evaluation']
        if row['choice'] is None:
            assert e['reason'] == 'local-sensitive-or-instruction-signal'
            continue
        original = by_id[row['id']]
        assert row['choice'] == original['choice']
        assert abs(row['confidence']-original['confidence']) < 1e-6
        for k, p in e['distributions']['tier']['probabilities'].items():
            assert abs(p-original['probabilities'][k]) < 1e-6
    groups = {'laya': final, 'jev': [r for r in remote if r['engine'] == 'jev'],
              'gemma': [r for r in remote if r['engine'] == 'gemma'], 'laya_affine_baseline': baseline}
    for engine in ['laya', 'jev', 'gemma']:
        blocked = {r['id'] for r in groups[engine] if r['evaluation']['reason'] == 'local-sensitive-or-instruction-signal'}
        assert blocked == {'tuning-183', 'tuning-197'}
    summary = {engine: metrics(rows) for engine, rows in groups.items()}
    summary['calibration'] = calibration_metrics(frozen, candidate['temperature'])
    three = []
    for row in load('production-final.jsonl'):
        e = row['three']; distribution = (e.get('distributions') or {}).get('tier', {})
        three.append({**row, 'expected': {'economy': 'middle', 'general': 'middle'}.get(row['expected'], row['expected']),
                      'choice': distribution.get('choice'), 'accepted': e['status'] == 'evaluated' and e['recommendedTier'] is not None,
                      'duration_ms': e['durationMs']})
    summary['three_tiers'] = metrics(three, ['basic', 'middle', 'advanced'])
    summary['target_met_on_this_test'] = (summary['laya']['accuracy'] >= summary['gemma']['accuracy']-.02
                                          and summary['laya']['coverage'] >= .9
                                          and summary['laya']['precision'] >= summary['gemma']['precision']-.02)
    assert summary['target_met_on_this_test']
    (RESULTS/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    lines = ['# Frozen multilingual Laya routing head: fresh 200-prompt test', '',
             'A specialized 3,076-parameter linear head over the frozen 322M multilingual Laya encoder improves routing accuracy and coverage. Temperature is fitted separately on old calibration data; the acceptance gate stays at 0.8.', '',
             '| Router | Correct / all | Accepted correct | Accepted precision | Coverage | Median gateway time |',
             '| --- | --- | --- | --- | --- | --- |']
    for name in groups:
        m = summary[name]
        lines.append(f"| {name} | {m['correct']}/200 ({100*m['accuracy']:.1f}%) | {m['accepted_correct']}/{m['accepted']} | {100*m['precision']:.1f}% | {100*m['coverage']:.1f}% | {m['median_ms']:.0f} ms |")
    lines += ['', '## What changed', '',
              'The old affine approach only had four output scores. The new readout sees the 768-dimensional mean encoder representation of the JSON task state. It retains the typed choice prefix and four activity descriptions, L2-normalizes features, and runs a trained linear softmax head. The original transformer encoder and decision-head weights are unchanged; the original decision head is not executed by the production readout. Three tiers sum the middle two probabilities.', '',
              'The head uses 520 previously inspected development cases. Selection compares all three checkpoints, three representations and four fixed penalties using grouped five-fold development predictions. Known translation pairs in the prompting dataset remain in the same fold; older sets are ordinal-grouped and thematic overlap can cross folds. Multilingual and typed encoders both reached 482/520; lower development log loss selected multilingual. The separate old 120-case calibration set fits one temperature (no threshold search). All fitting and model selection preceded new test authoring/inference. A later deterministic reproduction retains all 18,720 development predictions and confirms every selected coefficient and temperature is unchanged.', '',
              '## Confidence and fallback', '']
    for name, m in summary['calibration'].items():
        lines.append(f"- {name}: mean confidence {100*m['mean_confidence']:.1f}%, correctness Brier {m['selected_correctness_brier']:.4f}, 10-bin ECE {100*m['ece_10_equal_width']:.1f}%, accepted at 0.8: {m['accepted_at_0_8']}/200.")
    lines += ['', 'Temperature leaves labels unchanged. It addresses underconfidence for this trained head; it cannot repair a wrong zero-shot label. Confidence is calibrated selected-class probability, not the upstream entropy-derived concentration score. Low confidence and unavailable processes still preserve the configured route.', '',
              '## Actual plugin verification', '',
              'All eligible production distributions match frozen candidate inference to within 1e-6. The same disclosure guard excludes two cases for all three routers; they remain unresolved/incorrect in the 200-case denominator. JEV has one additional invalid-response result. There are no retries. The final exported artifact pins weights, encoder config and tokenizer hashes. Local metadata files not used in inference are excluded by export; this changes no fitted coefficient. The intermediate production run is retained, followed by a numerical regression run of the final export.', '',
              f"Three-tier grouping: {summary['three_tiers']['correct']}/200 correct, {summary['three_tiers']['accepted_correct']}/{summary['three_tiers']['accepted']} accepted correct. This was declared before fresh inference, but these are the same cases as the four-tier test.", '',
              '## Class and language audit', '', '| Tier | Laya correct / expected | Predicted |', '| --- | --- | --- |']
    for label, m in summary['laya']['per_class'].items():
        lines.append(f"| {label} | {m['correct']}/{m['expected']} | {m['predicted']} |")
    for language, m in summary['laya']['per_language'].items():
        lines.append(f"\n{language}: {m['correct']}/{m['n']} correct; {m['accepted_correct']}/{m['accepted']} accepted correct.")
    lines += ['', '## Limits', '',
              'This meets the declared Gemma accuracy/coverage target on this test. It does not establish production-wide superiority. The 200 synthetic cases have 100 correlated bilingual scenarios, one author, thematic overlap with development, and explicit specialist wording. Labels express the routing rubric, not downstream answer quality. Both technical facts and routine text about technical subjects are included, but real follow-ups, attachments and full histories are outside this classifier input contract. Confidence calibration uses only 120 cases. Inspect class boundaries and broader traffic before generalizing.', '',
              'Regression smoke checks accept Calculate 1+1, Berechne 2+4, Hallo and Hello as basic. A terse request, Debug this Python error., is misclassified as basic at 56.3% and rejected by the 0.8 gate; short context-free requests remain a limitation. These checks were added after fresh validation and are not held-out selection evidence.', '',
              'The live gateway and installed configuration were not modified or restarted. The source plugin needs reload/setup/start as applicable. Full raw results, development variants and provenance remain alongside this report.']
    (RESULTS/'report.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps({name: {k: summary[name][k] for k in ['accuracy', 'precision', 'coverage', 'median_ms']} for name in groups}, indent=2))


if __name__ == '__main__':
    main()
