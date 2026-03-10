import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const { resolveMemberDestination } = await import(
  '../skills/office/unpack.cjs'
);

describe('office unpack path validation', () => {
  test('rejects archive members that escape the output directory', () => {
    const outputDir = path.join(os.tmpdir(), 'hybridclaw-office-unpack-out');

    expect(() => resolveMemberDestination(outputDir, '../escape.txt')).toThrow(
      /outside the output directory/,
    );
  });

  test('rejects absolute archive member paths', () => {
    const outputDir = path.join(os.tmpdir(), 'hybridclaw-office-unpack-out');

    expect(() =>
      resolveMemberDestination(outputDir, '/tmp/escape.txt'),
    ).toThrow(/absolute path/);
  });

  test('resolves safe archive members inside the output directory', () => {
    const outputDir = path.join(os.tmpdir(), 'hybridclaw-office-unpack-out');

    expect(resolveMemberDestination(outputDir, 'word/document.xml')).toBe(
      path.join(outputDir, 'word', 'document.xml'),
    );
  });
});
