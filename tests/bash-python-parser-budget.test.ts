import { expect, test, vi } from 'vitest';
import { scriptCommands } from '../container/src/bash-commands.js';
import { findFetchedCode } from '../container/src/bash-remote-code.js';
import { useCleanMocks } from './test-utils.js';

const { readOnly } = vi.hoisted(() => ({ readOnly: vi.fn(() => ({ data: { reads: [], writes: [], pathHints: [] }, literals: [] })) }));
vi.mock('../container/src/python-data-inspection.js', () => ({
  inspectPythonInline: readOnly,
}));
useCleanMocks({
  cleanup: () => {
    readOnly.mockClear();
  },
});

test('one bounded parser allowance is shared by nested shells', () => {
  const read = 'python3 -c "print(open(\'/tmp/records.data\').read())"';
  const commands = [
    read,
    ...Array.from(
      { length: 8 },
      () =>
        `bash -c "python3 -c 'print(open(\\\"/tmp/records.data\\\").read())'"`,
    ),
  ];
  const result = findFetchedCode(
    scriptCommands(commands.join('; ')),
    new Set(['/tmp/records.data']),
  );
  expect(readOnly).toHaveBeenCalledTimes(4);
  expect(result.runs).toBe(true);
});
