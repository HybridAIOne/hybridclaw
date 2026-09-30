"""Offline routing evaluation using the production worker and explicit question payload.
This is a small regression set, not calibrated production accuracy evidence.
"""
import argparse
import json
from pathlib import Path
from worker import predict


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--questions', required=True)
    args = parser.parse_args()
    import laya_mlx
    agent = laya_mlx.load(args.model, dtype='float16')
    questions = json.loads(Path(args.questions).read_text())
    cases = json.loads(Path(__file__).with_name('routing-cases.json').read_text())
    rows = []
    for case in cases:
        answer = predict(agent, {'text': case['text'], 'questions': questions})['answers']['tier']
        rows.append({**case, 'choice': answer['choice'], 'probability': answer['confidence'],
                     'correct': answer['choice'] == case['expected'],
                     'accepted': answer['confidence'] >= 0.8})
    summary = {}
    for split in sorted({row['split'] for row in rows}):
        group = [row for row in rows if row['split'] == split]
        summary[split] = {'total': len(group), 'correct': sum(row['correct'] for row in group),
                          'accepted': sum(row['accepted'] for row in group),
                          'accepted_correct': sum(row['accepted'] and row['correct'] for row in group)}
    print(json.dumps({'summary': summary, 'rows': rows}, indent=2))


if __name__ == '__main__':
    main()
