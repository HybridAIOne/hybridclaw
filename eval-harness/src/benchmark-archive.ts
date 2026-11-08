/**
 * Dataset archives are data staged inside one task directory.
 * The suite's Python must supply tarfile's data filter. Unlike dataset loading,
 * extraction refuses runtimes without that capability; it never executes tasks.
 */
import fs from 'node:fs';
import { benchmarkCommand } from './benchmark-command.js';

export async function writeBase64TarToDirectory(
  encoded: string,
  targetDir: string,
  python: string,
  signal: AbortSignal,
): Promise<void> {
  if (!encoded.trim()) return;
  fs.mkdirSync(targetDir, { recursive: true });
  await benchmarkCommand({
    command: python,
    signal,
    args: [
      '-c',
      [
        'import base64, io, sys, tarfile',
        'if not callable(getattr(tarfile, "data_filter", None)):',
        '    raise RuntimeError("Archive extraction requires Python tarfile data filters; rerun suite setup with a current Python environment.")',
        'payload = sys.stdin.buffer.read()',
        'target = sys.argv[1]',
        'raw = base64.b64decode(payload)',
        "with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as tar:",
        '    tar.extractall(target, filter=tarfile.data_filter)',
      ].join('\n'),
      targetDir,
    ],
    input: encoded,
  });
}
