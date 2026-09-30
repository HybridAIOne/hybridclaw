"""Freeze model selection from development results before authoring a test.
The three fitted candidates and checkpoint provenance are required inputs.
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENGINES = ['typed', 'multilingual', 'english']


def main():
    parser = argparse.ArgumentParser()
    for engine in ENGINES:
        parser.add_argument('--'+engine, required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args(); output = Path(args.output)
    if output.exists():
        raise ValueError('Refuse overwrite')
    configs = {engine: json.loads(Path(getattr(args, engine)).read_text()) for engine in ENGINES}
    selected = min(ENGINES, key=lambda e: (-configs[e]['selected']['correct'], configs[e]['selected']['nll']))
    config = configs[selected]
    if config['representation'] != 'encoder_state':
        raise ValueError('The production export supports encoder-state readouts only')
    provenance = json.loads((ROOT/'checkpoints.json').read_text())[selected]
    if config['weight_sha256'] != provenance['weight_sha256']:
        raise ValueError('Checkpoint differs from recorded provenance')
    config['repo'], config['revision'] = provenance['repo'], provenance['revision']
    config['gateway_rubric_sha256'] = json.loads((ROOT.parents[2]/'plugins/laya-router/runtime/routing-calibration.json').read_text())['gateway_rubric_sha256']
    config['method'] = 'L2-normalized mean FP16 encoder state features; four-class linear softmax readout; separate temperature calibration'
    config['provenance'] = 'eval-harness/routing/tuning/PROTOCOL.md'
    output.write_text(json.dumps(config, indent=2)+'\n')
    print('Selected', selected)


if __name__ == '__main__':
    main()
