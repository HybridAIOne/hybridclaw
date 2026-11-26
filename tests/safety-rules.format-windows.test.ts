import { afterEach, expect, test } from 'vitest';
import {
  evaluateBashSafety,
  guardCommand,
} from '../container/src/bash-safety.js';
import { runBeforeToolHooks } from '../container/src/extensions.js';
import { configureSafetyRules } from '../container/src/safety-rules.js';

afterEach(() => configureSafetyRules(undefined));

test.each([
  'curl "https://example.com/api?action=query&format=json"',
  "curl 'https://example.com/api?action=query&format=xml'",
  'curl "https://example.com/api?x=1&format=json" && echo done',
  `node -e "fetch('https://example.com/api?action=query&format=json').then(r=>r.text()).then(console.log)"`,
  'echo "&format=json"',
  'FORMAT=json node script.js',
  'curl "https://example.com/api?x=1&format.exe=json"',
])('format assignments are not disk-format commands: %s', async (command) => {
  expect(guardCommand(command)).toBeNull();
  expect(
    evaluateBashSafety({
      toolName: 'bash',
      argsJson: JSON.stringify({ command }),
    }),
  ).toBeNull();
  expect(
    await runBeforeToolHooks('bash', JSON.stringify({ command })),
  ).toBeNull();
});

test.each([
  'format C:',
  'format.com /Q C:',
  'FORMAT.EXE/FS:NTFS C:',
  'FoRmAt.ExE /FS:NTFS D:',
  'format',
  'format.exe',
  'echo ready;format C:',
  'echo ready && format.exe /Q C:',
  'false || format.com C:',
  'echo data |format C:',
  'format\nC:',
  "bash -c 'echo ready; format C:'",
  'curl "https://example.com/api?x=1&format=json" && format C:',
])(
  'actual format commands retain the unconditional block: %s',
  async (command) => {
    expect(guardCommand(command)).toContain('format-windows');
    expect(
      evaluateBashSafety({
        toolName: 'bash',
        argsJson: JSON.stringify({ command }),
      })?.decision,
    ).toBe('denied');
    expect(
      await runBeforeToolHooks('bash', JSON.stringify({ command })),
    ).toContain('format-windows');
  },
);

test('a harmless query parameter does not hide independent safety blocks', () => {
  expect(
    guardCommand(
      'curl "https://example.com/?x=1&format=json" && rm -rf scratch',
    ),
  ).toContain('recursive-delete');
  expect(
    guardCommand(
      'curl "https://example.com/?x=1&format=json"; mkfs.ext4 /dev/example',
    ),
  ).toContain('format-unix');
});

test('only an explicitly disabled format rule stops blocking format commands', () => {
  configureSafetyRules(['format-windows']);
  expect(guardCommand('format C:')).toBeNull();
  expect(guardCommand('mkfs.ext4 /dev/example')).toContain('format-unix');
  configureSafetyRules(undefined);
  expect(guardCommand('format C:')).toContain('format-windows');
});
