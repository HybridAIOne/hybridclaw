"""Fixed Laya ablations over the authored dataset; no live router changes.
Score decoding is explicit: argmax is primary, rounded expectation is diagnostic.
"""
import argparse
import hashlib
import json
from importlib.metadata import version
import math
from pathlib import Path
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--baseline', required=True, help='Recorded production metadata.json')
    parser.add_argument('--output', required=True)
    parser.add_argument('--checkpoint', required=True, help='Repository and pinned revision for provenance')
    args = parser.parse_args()
    root = Path(__file__).parent
    dataset = json.loads((root / 'dataset.json').read_text())
    baseline = json.loads(Path(args.baseline).read_text())
    criteria = baseline['criteria']
    tiers = list(criteria)
    questions = {
        'difficulty': baseline['typedQuestion'],
        'category': 'Which category best describes the task?',
        'capability': "Choose the lowest capability level needed to complete the user's task.",
    }
    variants = []
    for kind in ['choice', 'score']:
        for state in ['raw', 'json', 'prefixed']:
            for wording, instructions in questions.items():
                variants.append({'name': f'{kind}-{state}-{wording}', 'kind': kind,
                                 'state': state, 'instructions': instructions,
                                 'criteria': criteria if kind == 'choice' else list(criteria.values())})
    variants += [
        {'name': 'choice-raw-neutral-labels', 'kind': 'choice', 'state': 'raw',
         'instructions': questions['difficulty'], 'criteria': dict(zip('ABCD', criteria.values())),
         'labels': dict(zip('ABCD', tiers))},
        {'name': 'choice-raw-reversed-options', 'kind': 'choice', 'state': 'raw',
         'instructions': questions['difficulty'], 'criteria': dict(reversed(list(criteria.items())))},
    ]
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    with (Path(args.model) / 'model.safetensors').open('rb') as weights:
        weight_hash = hashlib.file_digest(weights, 'sha256').hexdigest()
    (output / 'design.json').write_text(json.dumps({
        'dataset_sha256': hashlib.sha256((root / 'dataset.json').read_bytes()).hexdigest(),
        'variants': variants, 'threshold': .8,
        'checkpoint': args.checkpoint, 'runtime': f'laya-mlx=={version("laya-mlx")}',
        'weight_sha256': weight_hash,
        'model_config': json.loads((Path(args.model) / 'rl_agent_config.json').read_text()),
        'dtype': 'float16',
        'note': '20 variants fixed before inference. Existing 200-case corpus is exploratory, not fresh validation. No tuning during the run. Choice gate uses selected probability; score gate uses modal level probability. Rounded score is a separate diagnostic.'
    }, indent=2))
    import laya_mlx
    agent = laya_mlx.load(args.model, dtype='float16')
    summaries = []
    with (output / 'results.jsonl').open('w') as stream:
        for variant in variants:
            rows = []
            definition = {'type': variant['kind'], 'instructions': variant['instructions'],
                          'criteria': variant['criteria']}
            for case in dataset['cases']:
                text = case['text']
                state = {'task': text} if variant['state'] == 'json' else f'User request:\n{text}' if variant['state'] == 'prefixed' else text
                started = time.perf_counter()
                result = agent.predict(state, {'tier': definition})
                elapsed = (time.perf_counter() - started) * 1000
                answer = result['answers']['tier']
                probabilities = answer['probabilities']
                if variant['kind'] == 'choice':
                    label = answer['choice']
                    chosen = variant.get('labels', {}).get(label, label)
                    rounded = None
                else:
                    label = max(probabilities, key=probabilities.get)
                    chosen = tiers[int(label)]
                    rounded = tiers[min(len(tiers)-1, math.floor(answer['score']+.5))]
                probability = probabilities[label]
                row = {'variant': variant['name'], 'id': case['id'], 'language': case['language'],
                       'expected': case['expected'], 'choice': chosen, 'probability': probability,
                       'entropy': answer['confidence'], 'accepted': probability >= .8,
                       'rounded_score_choice': rounded, 'score': answer.get('score'),
                       'duration_ms': round(elapsed, 3), 'input_tokens': result['usage']['input_tokens']}
                rows.append(row)
                stream.write(json.dumps(row)+'\n')
            stream.flush()
            def correct(group): return sum(r['choice']==r['expected'] for r in group)
            accepted = [r for r in rows if r['accepted']]
            summary = {'variant': variant['name'], 'correct': correct(rows),
                       'en': correct([r for r in rows if r['language']=='en']),
                       'de': correct([r for r in rows if r['language']=='de']),
                       'accepted': len(accepted), 'accepted_correct': correct(accepted),
                       'basic': correct([r for r in rows if r['expected']==tiers[0]]),
                       'rounded_score_correct': sum(r['rounded_score_choice']==r['expected'] for r in rows) if variant['kind']=='score' else None,
                       'p50_ms': sorted(r['duration_ms'] for r in rows)[99]}
            summaries.append(summary)
            print(json.dumps(summary), flush=True)
    (output / 'summary.json').write_text(json.dumps(summaries, indent=2)+'\n')
    lines = ['# Laya: decision type, state and question ablation', '',
             f'Checkpoint: {args.checkpoint}. FP16, same 200 labeled prompts. Twenty variants specified before this run. '
             'This reuses an inspected corpus and is exploratory; ranking variants on it is not independent validation.', '',
             'State formats: raw text, JSON object with a task field, and text prefixed with User request. '
             'Choice receives named criteria; score receives the same descriptions as an ordered list. '
             'Score selects the highest-probability level, not a rounded expected value. '
             'All acceptance figures use the selected level probability ≥80%, not entropy.', '',
             '| Variant | Correct /200 | EN /100 | DE /100 | Basic /50 | Accepted | Correct among accepted | Rounded score correct /200 |',
             '|---|---:|---:|---:|---:|---:|---:|---:|']
    for s in sorted(summaries, key=lambda r:r['correct'], reverse=True):
        lines.append(f"| {s['variant']} | {s['correct']} | {s['en']} | {s['de']} | {s['basic']} | {s['accepted']} | {s['accepted_correct']} | {s['rounded_score_correct'] if s['rounded_score_correct'] is not None else '—'} |")
    lines += ['', 'The JSON design and per-call JSONL preserve all variants and outcomes, including poor results. '
              'No variant was promoted to production and no cloud calls were made. '
              'Latency here is direct warm Python/MLX inference, not the gateway timing from the three-router comparison.', '']
    (output / 'report.md').write_text('\n'.join(lines))


if __name__ == '__main__':
    main()
