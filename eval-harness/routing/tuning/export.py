"""Generate the production readout from the frozen selected candidate.
Only fields used by serving are exported; no fitting or model selection occurs.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def artifact(source=ROOT/'candidate.json'):
    config = json.loads(source.read_text())
    result = {k: config[k] for k in ['repo', 'revision', 'weight_sha256', 'question',
                                  'matrix', 'bias', 'temperature', 'gateway_rubric_sha256']}
    files = ['encoder/config.json', 'rl_agent_config.json',
             'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json']
    result['model_files_sha256'] = {k: config['model_files_sha256'][k] for k in files}
    result['method'] = config['method']
    result['provenance'] = {'candidate_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                            'protocol': 'eval-harness/routing/tuning/PROTOCOL.md'}
    return result


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--output', required=True)
    parser.add_argument('--candidate', default=str(ROOT/'candidate.json'))
    args = parser.parse_args()
    Path(args.output).write_text(json.dumps(artifact(Path(args.candidate)), indent=2)+'\n')


if __name__ == '__main__':
    main()
