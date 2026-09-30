"""Restore the pinned training checkpoints without depending on temporary clones.
Downloads go to an explicit local directory and weights must match recorded hashes.
"""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    pins = json.loads(Path(__file__).with_name('checkpoints.json').read_text())
    parser = argparse.ArgumentParser()
    parser.add_argument('--checkpoint', choices=list(pins), required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args(); pin = pins[args.checkpoint]
    output = Path(args.output)
    from huggingface_hub import snapshot_download
    snapshot_download(pin['repo'], revision=pin['revision'], local_dir=output,
                      cache_dir=output.parent/'hub-cache',
                      allow_patterns=['*.json', '*.safetensors', 'encoder/*.json', 'tokenizer/*'])
    with (output/'model.safetensors').open('rb') as f:
        if hashlib.file_digest(f, 'sha256').hexdigest() != pin['weight_sha256']:
            raise ValueError('Checkpoint weights differ from the pinned revision')
    print('Verified', args.checkpoint)


if __name__ == '__main__':
    main()
